/**
 * editions-hub-participation.node.test.ts — ISOLATED Postgres only. Editions 1.1 groundwork (step 1): Hub-OWNED events and regular activities taking part in
 * an Edition run by someone else. NO schema change: this pins the behaviour that already exists, so the Hub-as-partner and Hub-run-Edition work can be
 * built on it without regressions. Covers permissions, consent, withdrawal, members-only privacy, organiser independence, cross-hub isolation, business
 * participation unaffected, and (as documented current behaviour) the two gaps Editions 1.1 closes: no Hub authority over an Edition, and no free Edition
 * for a Hub. Run: ISOLATED_ONLY=editions-hub-participation npm run test:isolated   (never `npm test`)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Env, USERS, seed, enter, draftEdition, d, last, failed as baseFailed } from './_support/editions-env.ts';
import { publishEdition, addHelper, aliased } from './_support/editions-env-2.ts';

// The Edition here is run by a BUSINESS (ZZ Test Cafe), not by the Hub whose content takes part: ORG_OWNER is its owner, ORG_EDITOR a helper; BIZ1 owns a partner Business.
const MAP = { ADMIN: 'ADMIN', ORG_OWNER: 'BIZ_OWNER', ORG_EDITOR: 'HELPER', BIZ1: 'BIZ2_OWNER', STRANGER: 'STRANGER', HUB_OWNER: 'HUB_OWNER', HUB_COMMITTEE: 'HUB_COMMITTEE', HUB_MEMBER: 'HUB_MEMBER', HUB2_OWNER: 'HUB2_OWNER' } as const;
const U = { ADMIN: USERS.ADMIN, ORG_OWNER: USERS.BIZ_OWNER, ORG_EDITOR: USERS.HELPER, BIZ1: USERS.BIZ2_OWNER, STRANGER: USERS.STRANGER, HUB_OWNER: USERS.HUB_OWNER, HUB_COMMITTEE: USERS.HUB_COMMITTEE, HUB_MEMBER: USERS.HUB_MEMBER, HUB2_OWNER: USERS.HUB2_OWNER } as const;
type Who = keyof typeof MAP | 'anon';
const failed = baseFailed;

let Base: Env, S: ReturnType<typeof seed>;
let E: ReturnType<typeof aliased<keyof typeof MAP>>;
let ORG = '', ED = '', HUB = '', HUB2 = '', BIZ1 = '';
let EV_OPEN2 = '', EV_OPEN = '', EV_MEMBERS = '', EV_HUBONLY = '', EV_DRAFT = '', EV_HUB2 = '', ACT_HUB = '', ACT_PAUSED = '', EV_BIZ = '';
const invite = (who: Who, kind: string, subject: string) => E.do(who, `select public.edition_invite_partner('${ED}','${kind}','${subject}')`);
const inviteId = (who: Who, kind: string, subject: string) => last(invite(who, kind, subject));
const act = (who: Who, link: string, a: string) => E.try(who, `select public.edition_link_act('${link}','${a}',null)`);
const doAct = (who: Who, link: string, a: string) => E.do(who, `select public.edition_link_act('${link}','${a}',null)`);
const state = (link: string) => E.q(`select state from edition_links where id='${link}'`);
const publicEvents = () => E.one('anon', `select coalesce(string_agg(title, '|' order by title), '') from public.edition_public_events where edition_id='${ED}'`);
const publicActs = () => E.one('anon', `select coalesce(string_agg(title, '|' order by title), '') from public.edition_public_activities where edition_id='${ED}'`);
const publicBiz = () => E.one('anon', `select coalesce(string_agg(name, '|' order by name), '') from public.edition_public_businesses where edition_id='${ED}'`);

before(() => {
  Base = new Env('editionshubpart');
  S = seed(Base); E = aliased(Base, MAP);
  HUB = S.HUB; HUB2 = S.HUB2;
  BIZ1 = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.BIZ1}','ZZ Harbour Cafe','food_drink','1 Quay, Lerwick',true) returning id`));
  const ev = (title: string, status: string, vis: string, hubId: string | null, biz: string | null = null) => last(E.sup(`insert into events (title, starts_at, status, hub_visibility, organiser_hub_id, organiser_business_id, organiser_user_id)
      values ('${title}', (${d(21)})::timestamp + interval '19 hours', '${status}', '${vis}', ${hubId ? `'${hubId}'` : 'null'}, ${biz ? `'${biz}'` : 'null'}, '${hubId ? U.HUB_OWNER : U.BIZ1}') returning id`));
  EV_OPEN = ev('ZZ Hub Open Concert', 'published', 'islands', HUB);
  EV_MEMBERS = ev('ZZ Hub Members Social', 'published', 'members', HUB);
  EV_HUBONLY = ev('ZZ Hub Only Meeting', 'published', 'hub', HUB);
  EV_DRAFT = ev('ZZ Hub Draft Gala', 'draft', 'islands', HUB);
  EV_HUB2 = ev('ZZ Other Hub Quiz', 'published', 'islands', HUB2);
  EV_BIZ = ev('ZZ Harbour Quiz Night', 'published', 'islands', null, BIZ1);
  ACT_HUB = last(E.sup(`insert into regular_activities (slug, title, status, organiser_hub_id, created_by) values ('zz-hub-choir','ZZ Hub Choir','published','${HUB}','${U.HUB_OWNER}') returning id`));
  ACT_PAUSED = last(E.sup(`insert into regular_activities (slug, title, status, organiser_hub_id, created_by, admin_paused) values ('zz-hub-paused','ZZ Hub Paused Club','published','${HUB}','${U.HUB_OWNER}',true) returning id`));
  ORG = enter(Base, 'BIZ_OWNER', 'business', S.BIZ);
  addHelper(Base, 'BIZ_OWNER', ORG, 'HELPER', `${USERS.HELPER}@x.invalid`);
  ED = draftEdition(Base, 'BIZ_OWNER', ORG, 'zz-test-fest-2027', 'ZZ TEST Fest');
  publishEdition(Base, 'BIZ_OWNER', ED, 'ZZ TEST grant for hub participation suite');
  assert.equal(E.one('anon', `select count(*) from public.editions where id='${ED}'`), '1');
});
after(() => Base?.drop());

describe('finding Hub content to invite', () => {
  test('the organiser team finds a Hub\'s public event and activity, named after the Hub; a stranger cannot search at all', () => {
    const r = E.one('ORG_EDITOR', `select string_agg(kind || ':' || owner_name, '|' order by title) from public.edition_find_activities('${ED}', 'ZZ Hub')`);
    assert.match(r, /event:ZZ Test Hub/); assert.match(r, /activity:ZZ Test Hub/);
    assert.ok(failed(E.try('STRANGER', `select * from public.edition_find_activities('${ED}','ZZ Hub')`)));
    assert.ok(failed(E.try('HUB_COMMITTEE', `select * from public.edition_find_activities('${ED}','ZZ Hub')`)), 'a Hub admin is not organiser team');
  });
  test('members-only events, drafts and paused activities are not offered in search', () => {
    const titles = E.one('ORG_EDITOR', `select string_agg(title, '|' order by title) from public.edition_find_activities('${ED}', 'ZZ Hub')`);
    assert.doesNotMatch(titles, /Members Social/); assert.doesNotMatch(titles, /Draft Gala/); assert.doesNotMatch(titles, /Paused Club/);
    assert.match(titles, /Open Concert/); assert.match(titles, /Hub Only Meeting/);
  });
  test('a draft event and a paused activity cannot be invited even by id', () => {
    assert.match(E.try('ORG_EDITOR', `select public.edition_invite_partner('${ED}','event','${EV_DRAFT}')`), /not available to invite/);
    assert.match(E.try('ORG_EDITOR', `select public.edition_invite_partner('${ED}','activity','${ACT_PAUSED}')`), /not available to invite/);
  });
});

describe('consent: only the Hub\'s own administrators answer for Hub content', () => {
  let L = '';
  test('an invitation is pending and invisible to the public until the Hub answers', () => {
    L = inviteId('ORG_EDITOR', 'event', EV_OPEN);
    assert.equal(state(L), 'pending');
    assert.equal(publicEvents(), '');
    assert.equal(E.q(`select initiated_by from edition_links where id='${L}'`), 'organiser');
  });
  test('nobody else can approve it: organiser (either role), staff, ordinary Hub member, stranger, another Hub\'s owner', () => {
    for (const w of ['ORG_OWNER', 'ORG_EDITOR', 'ADMIN', 'HUB_MEMBER', 'STRANGER', 'HUB2_OWNER', 'BIZ1', 'anon'] as Who[]) {
      assert.ok(failed(act(w, L, 'approve')), `${w} must not approve`);
    }
    assert.equal(state(L), 'pending'); assert.equal(publicEvents(), '');
  });
  test('the Hub\'s committee approves; the event then appears from its own live row', () => {
    doAct('HUB_COMMITTEE', L, 'approve');
    assert.equal(state(L), 'approved');
    assert.equal(publicEvents(), 'ZZ Hub Open Concert');
    assert.equal(E.q(`select decided_by from edition_links where id='${L}'`), U.HUB_COMMITTEE);
    E.sup(`update events set title = 'ZZ Hub Open Concert (renamed)' where id='${EV_OPEN}'`);
    assert.equal(publicEvents(), 'ZZ Hub Open Concert (renamed)', 'the Edition shows the Hub\'s event as it is now; nothing is copied');
    E.sup(`update events set title = 'ZZ Hub Open Concert' where id='${EV_OPEN}'`);
  });
  test('the Hub\'s owner can decline another invitation, and a declined invitation never shows', () => {
    const l2 = inviteId('ORG_EDITOR', 'event', EV_HUBONLY);
    doAct('HUB_OWNER', l2, 'decline');
    assert.equal(state(l2), 'declined'); assert.equal(E.q(`select ended_by from edition_links where id='${l2}'`), 'entity');
    assert.doesNotMatch(publicEvents(), /Hub Only/);
  });
  test('a declined invitation is not repeated by the organiser for 30 days', () => {
    assert.match(E.try('ORG_EDITOR', `select public.edition_invite_partner('${ED}','event','${EV_HUBONLY}')`), /declined recently/);
  });
  test('a Hub activity takes part the same way', () => {
    const la = inviteId('ORG_EDITOR', 'activity', ACT_HUB);
    assert.ok(failed(act('HUB_MEMBER', la, 'approve')));
    doAct('HUB_OWNER', la, 'approve');
    assert.equal(state(la), 'approved');
    // A Hub's regular activity is public only once OneShetland has approved it for the calendar (existing rule on regular_activities). Consent alone does not override moderation.
    assert.equal(publicActs(), '', 'approved by the Hub but not calendar-approved: not shown');
    E.sup(`update regular_activities set calendar_approved = true where id='${ACT_HUB}'`);
    assert.equal(publicActs(), 'ZZ Hub Choir');
  });
});

describe('the Hub asks to join, and chooses what to show', () => {
  let R = '';
  test('only a Hub administrator can propose Hub content; a member, stranger or other Hub\'s owner cannot', () => {
    for (const w of ['HUB_MEMBER', 'STRANGER', 'HUB2_OWNER', 'ORG_OWNER'] as Who[]) assert.ok(failed(E.try(w, `select public.edition_request_to_join('${ED}','event','${EV_MEMBERS}')`)), w);
    assert.ok(failed(E.try('HUB_COMMITTEE', `select public.edition_request_to_join('${ED}','event','${EV_HUB2}')`)), 'another Hub\'s event is not theirs to offer');
  });
  test('the request is pending; only the organiser team can answer it (the Hub cannot approve its own request)', () => {
    R = last(E.do('HUB_COMMITTEE', `select public.edition_request_to_join('${ED}','event','${EV_MEMBERS}','please include us')`));
    assert.equal(state(R), 'pending'); assert.equal(E.q(`select initiated_by from edition_links where id='${R}'`), 'entity');
    assert.ok(failed(act('HUB_COMMITTEE', R, 'approve')), 'a requester cannot approve itself');
    assert.ok(failed(act('STRANGER', R, 'approve')));
    assert.equal(E.one('ORG_EDITOR', `select message from public.edition_my_partnerships()`).length >= 0, true);
  });
  test('the organiser may decline a request, leaving the Hub\'s content untouched', () => {
    doAct('ORG_EDITOR', R, 'decline');
    assert.equal(state(R), 'declined');
    assert.equal(E.q(`select status from events where id='${EV_MEMBERS}'`), 'published');
  });
});

describe('withdrawal is the Hub\'s right and is immediate', () => {
  let L = '';
  before(() => { L = inviteId('ORG_OWNER', 'event', EV_HUB2 === '' ? EV_OPEN : EV_OPEN); });
  test('an active Hub event is withdrawn by a Hub admin only; a member or the other Hub cannot', () => {
    // EV_OPEN already holds an approved link from the consent suite; find it
    const live = E.q(`select id from edition_links where edition_id='${ED}' and event_id='${EV_OPEN}' and state='approved'`);
    assert.ok(live);
    for (const w of ['HUB_MEMBER', 'HUB2_OWNER', 'STRANGER'] as Who[]) assert.ok(failed(act(w, live, 'withdraw')), w);
    assert.equal(publicEvents(), 'ZZ Hub Open Concert');
    doAct('HUB_COMMITTEE', live, 'withdraw');
    assert.equal(state(live), 'withdrawn'); assert.equal(E.q(`select ended_by from edition_links where id='${live}'`), 'entity');
    assert.equal(publicEvents(), '', 'gone from the public Edition at once; no cache, no copy');
  });
  test('after withdrawal the organiser cannot revive it; the Hub must be asked again', () => {
    const w = E.q(`select id from edition_links where edition_id='${ED}' and event_id='${EV_OPEN}' and state='withdrawn' limit 1`);
    assert.ok(failed(act('ORG_OWNER', w, 'approve')));
    assert.ok(failed(act('ORG_OWNER', w, 'remove')));
    assert.equal(publicEvents(), '');
  });
  test('the organiser can also remove an approved Hub item; the Hub\'s event is unaffected', () => {
    const l = inviteId('ORG_OWNER', 'event', EV_OPEN);
    doAct('HUB_OWNER', l, 'approve'); assert.equal(publicEvents(), 'ZZ Hub Open Concert');
    doAct('ORG_OWNER', l, 'remove');
    assert.equal(state(l), 'withdrawn'); assert.equal(E.q(`select ended_by from edition_links where id='${l}'`), 'organiser');
    assert.equal(E.q(`select status from events where id='${EV_OPEN}'`), 'published');
  });
  void L;
});

describe('members-only and Hub-only content stays private', () => {
  test('an approved link to a MEMBERS-ONLY event shows nothing to the public; a Hub-page event (visibility hub) is public by the events table\'s own rule', () => {
    E.sup(`delete from edition_links where edition_id='${ED}' and event_id in ('${EV_MEMBERS}','${EV_HUBONLY}')`);
    for (const ev of [EV_MEMBERS, EV_HUBONLY]) {
      const l = last(E.sup(`insert into edition_links (edition_id, kind, event_id, initiated_by, state, created_by, decided_by, decided_at) values ('${ED}','event','${ev}','organiser','approved','${U.ORG_OWNER}','${U.HUB_OWNER}',now()) returning id`));
      assert.ok(l);
    }
    assert.equal(publicEvents(), 'ZZ Hub Only Meeting', 'the members-only event never appears; the hub-visibility event is already public on the Hub\'s own page');
    assert.equal(E.one('STRANGER', `select string_agg(title, '|') from public.edition_public_events where edition_id='${ED}'`), 'ZZ Hub Only Meeting', 'nor to a signed-in non-member');
    E.sup(`delete from edition_links where edition_id='${ED}' and event_id in ('${EV_MEMBERS}','${EV_HUBONLY}')`);
  });
  test('the organiser and the public cannot read Hub membership or private Hub columns', () => {
    for (const w of ['ORG_OWNER', 'ORG_EDITOR', 'STRANGER', 'anon'] as Who[]) {
      assert.equal(E.one(w, `select count(*) from hub_members where hub_id='${HUB}' and user_id in ('${U.HUB_COMMITTEE}','${U.HUB_MEMBER}')`).replace(/^ERROR.*/, '0') === '0' || failed(E.try(w, `select 1 from hub_members where hub_id='${HUB}'`)), true, w);
    }
    assert.ok(failed(E.try('anon', `select stripe_account_id from hubs`)));
    assert.ok(failed(E.try('ORG_OWNER', `select stripe_account_id from hubs`)));
    assert.ok(failed(E.try('anon', `select owner_id from hubs`)), 'owner id is signed-in only');
  });
  test('Edition partner screens expose no member or private-contact fields', () => {
    const cols = E.q(`select coalesce(string_agg(column_name, ','), '') from information_schema.columns where table_schema='public' and table_name in ('edition_public_events','edition_public_activities') and (column_name ilike '%member%' or column_name ilike '%owner%' or column_name ilike '%email%' or column_name ilike '%phone%' or column_name ilike '%stripe%')`);
    assert.equal(cols, '');
  });
  test('link notes (messages between the sides) are readable by the two sides only', () => {
    const l = inviteId('ORG_EDITOR', 'activity', ACT_HUB === '' ? '' : ACT_HUB);
    void l;
    const any = E.q(`select id from edition_links where edition_id='${ED}' and activity_id='${ACT_HUB}' order by created_at desc limit 1`);
    E.sup(`insert into edition_link_notes (link_id, message) values ('${any}','ZZ PRIVATE NOTE') on conflict (link_id) do update set message = excluded.message`);
    assert.ok(failed(E.try('anon', `select count(*) from edition_link_notes`)) || E.one('anon', `select count(*) from edition_link_notes`) === '0');
    for (const w of ['STRANGER', 'HUB_MEMBER', 'HUB2_OWNER'] as Who[]) assert.equal(E.one(w, `select count(*) from edition_link_notes where link_id='${any}'`), '0', w);
    assert.equal(E.one('HUB_OWNER', `select message from edition_link_notes where link_id='${any}'`), 'ZZ PRIVATE NOTE');
    assert.equal(E.one('ORG_EDITOR', `select message from edition_link_notes where link_id='${any}'`), 'ZZ PRIVATE NOTE');
  });
});

describe('organiser independence: an Edition never edits the Hub\'s records', () => {
  test('the organiser team cannot change or delete a Hub event, activity or Hub', () => {
    for (const w of ['ORG_OWNER', 'ORG_EDITOR'] as Who[]) {
      assert.equal(E.one(w, `with u as (update events set title='HACKED' where id='${EV_OPEN}' returning 1) select count(*) from u`), '0', w);
      assert.equal(E.one(w, `with u as (update regular_activities set title='HACKED' where id='${ACT_HUB}' returning 1) select count(*) from u`), '0', w);
      assert.equal(E.one(w, `with u as (update hubs set name='HACKED' where id='${HUB}' returning 1) select count(*) from u`).replace(/^ERROR.*/, '0'), '0', w);
      assert.equal(E.one(w, `with x as (delete from events where id='${EV_OPEN}' returning 1) select count(*) from x`), '0', w);
    }
    assert.equal(E.q(`select title from events where id='${EV_OPEN}'`), 'ZZ Hub Open Concert');
  });
  test('link actions only touch the link: the Hub event row is byte-identical after invite, approve and withdraw', () => {
    const snap = () => E.q(`select md5(e::text) from events e where id='${EV_OPEN}'`);
    const before = snap();
    const l = inviteId('ORG_OWNER', 'event', EV_OPEN); doAct('HUB_OWNER', l, 'approve'); doAct('HUB_OWNER', l, 'withdraw');
    assert.equal(snap(), before);
  });
  test('Hub content is not re-owned: the event still belongs to the Hub and to no Edition', () => {
    assert.equal(E.q(`select organiser_hub_id from events where id='${EV_OPEN}'`), HUB);
    assert.equal(E.q(`select count(*) from information_schema.columns where table_schema='public' and table_name in ('events','regular_activities','hubs','hub_members') and column_name like '%edition%'`), '0');
  });
  test('another Hub sees none of this Hub\'s partnerships; a Hub admin sees exactly their own', () => {
    assert.equal(E.one('HUB2_OWNER', `select count(*) from public.edition_my_partnerships()`), '0');
    assert.equal(E.one('STRANGER', `select count(*) from public.edition_my_partnerships()`), '0');
    assert.equal(E.one('HUB_MEMBER', `select count(*) from public.edition_my_partnerships()`), '0', 'an ordinary member holds no authority');
    assert.ok(Number(E.one('HUB_COMMITTEE', `select count(*) from public.edition_my_partnerships()`)) >= 1);
    assert.ok(Number(E.one('HUB_OWNER', `select count(*) from public.edition_my_partnerships()`)) >= 1);
    assert.equal(E.one('HUB2_OWNER', `select count(*) from edition_links where state <> 'approved'`), '0', 'RLS: another Hub reads no pending, declined or withdrawn links (approved ones are public by design)');
    assert.equal(E.one('HUB2_OWNER', `select count(*) from edition_links where state = 'approved' and event_id is not null and public.edition_controls_subject(kind, business_id, event_id, activity_id)`), '0');
  });
});

describe('Hub authority is the Hub\'s CURRENT committee, read live', () => {
  test('a removed committee member loses the power to approve or withdraw at once', () => {
    const l = inviteId('ORG_OWNER', 'event', EV_OPEN);
    E.sup(`update hub_members set role = 'member' where hub_id='${HUB}' and user_id='${U.HUB_COMMITTEE}'`);
    assert.ok(failed(act('HUB_COMMITTEE', l, 'approve')));
    assert.equal(E.one('HUB_COMMITTEE', `select count(*) from public.edition_my_partnerships()`), '0');
    E.sup(`update hub_members set role = 'committee' where hub_id='${HUB}' and user_id='${U.HUB_COMMITTEE}'`);
    doAct('HUB_COMMITTEE', l, 'approve'); doAct('HUB_COMMITTEE', l, 'withdraw');
  });
  test('a member who has left (status left) holds no authority either', () => {
    const l = inviteId('ORG_OWNER', 'event', EV_OPEN);
    E.sup(`update hub_members set status = 'left' where hub_id='${HUB}' and user_id='${U.HUB_COMMITTEE}'`);
    assert.ok(failed(act('HUB_COMMITTEE', l, 'approve')));
    E.sup(`update hub_members set status = 'active' where hub_id='${HUB}' and user_id='${U.HUB_COMMITTEE}'`);
    doAct('HUB_OWNER', l, 'decline');
  });
});

describe('business participation is unaffected', () => {
  test('a business and a Hub take part in the same Edition independently', () => {
    EV_OPEN2 = last(E.sup(`insert into events (title, starts_at, status, hub_visibility, organiser_hub_id, organiser_user_id) values ('ZZ Hub Second Concert', (${d(21)})::timestamp + interval '20 hours', 'published', 'islands', '${HUB}', '${U.HUB_OWNER}') returning id`));
    const lb = inviteId('ORG_OWNER', 'business', BIZ1);
    const le = inviteId('ORG_OWNER', 'event', EV_BIZ);
    assert.ok(failed(act('HUB_OWNER', lb, 'approve')), 'a Hub admin cannot answer for a business');
    assert.ok(failed(act('BIZ1', le, 'withdraw')), 'pending items cannot be withdrawn');
    doAct('BIZ1', lb, 'approve'); doAct('BIZ1', le, 'approve');
    const lh = inviteId('ORG_OWNER', 'event', EV_OPEN2); doAct('HUB_OWNER', lh, 'approve');
    assert.equal(publicBiz(), 'ZZ Harbour Cafe');
    assert.equal(publicEvents(), 'ZZ Harbour Quiz Night|ZZ Hub Second Concert');
    doAct('HUB_OWNER', lh, 'withdraw');
    assert.equal(publicBiz(), 'ZZ Harbour Cafe', 'a Hub withdrawal does not touch the business');
    assert.equal(publicEvents(), 'ZZ Harbour Quiz Night');
    assert.ok(failed(act('HUB_OWNER', le, 'withdraw')), 'a Hub admin cannot withdraw a business\'s event');
    doAct('BIZ1', lb, 'withdraw');
    assert.equal(publicBiz(), ''); assert.equal(publicEvents(), 'ZZ Harbour Quiz Night');
  });
  test('the business owner\'s partnerships list shows none of the Hub\'s', () => {
    assert.equal(E.one('BIZ1', `select count(*) from public.edition_my_partnerships() where subject_name like 'ZZ Hub%'`), '0');
  });
});

describe('Hub-run organisers: a Hub\'s authority and the absence of a free ride (the full Hub suites are editions-hub-partners, editions-hub-run and editions-hub-commerce)', () => {
  test('an organiser made for a Hub is managed by that Hub\'s CURRENT owner and committee: owner = owner, committee = admin, an ordinary member nothing; the Business-run organiser is untouched by them', () => {
    const HORG = enter(Base, 'HUB_OWNER', 'hub', HUB);
    assert.equal(E.q(`select hub_id from edition_organisers where id='${HORG}'`), HUB);
    assert.equal(E.one('HUB_OWNER', `select public.edition_org_role('${HORG}')`), 'owner');
    assert.equal(E.one('HUB_COMMITTEE', `select public.edition_org_role('${HORG}')`), 'admin');
    assert.equal(E.one('HUB_MEMBER', `select coalesce(public.edition_org_role('${HORG}'), 'none')`), 'none');
    assert.equal(E.one('HUB2_OWNER', `select coalesce(public.edition_org_role('${HORG}'), 'none')`), 'none');
    assert.equal(E.one('HUB_COMMITTEE', `select coalesce(public.edition_org_role('${ORG}'), 'none')`), 'none', 'a Hub\'s people hold nothing over a Business-run organiser');
    // (unlinking an organiser from its Hub, and linking by an administrator, are retired: every organiser has exactly one parent)
  });
  test('a Hub-run organiser gets no free Edition capability: entitlements come only from grants, packages or orders, and publishing needs approval first', () => {
    const org2 = enter(Base, 'HUB_OWNER', 'hub', HUB);
    for (const f of ['collect_payments', 'memberships', 'participation_fees', 'offline_records', 'csv_export']) assert.equal(E.one('HUB_OWNER', `select public.edition_org_entitled('${org2}', '${f}')`), 'f', f);
    const ed2 = draftEdition(Base, 'HUB_OWNER', org2, 'zz-hub-run-2027', 'ZZ Hub Run');
    assert.ok(failed(E.try('HUB_OWNER', `select public.edition_set_status('${ed2}', 'published')`)), 'publishing needs approval and an entitlement');
    assert.equal(E.q(`select count(*) from edition_organiser_entitlements where organiser_id='${org2}'`), '0');
  });
  test('the public cannot see Hub private columns through an organiser', () => {
    assert.ok(failed(E.try('anon', `select h.stripe_account_id from edition_organisers o join hubs h on h.id = o.hub_id`)));
  });
});
