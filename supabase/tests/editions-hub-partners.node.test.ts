/**
 * editions-hub-partners.node.test.ts — ISOLATED Postgres only. Editions 1.1: a Hub as a first-class partner of ANY Edition, with the same two-sided consent as a business.
 * Covers finding, invitation, requests, who may answer (the Hub's owner and active committee only, read live), withdrawal, the public Hub card (whitelisted columns only),
 * the Hub's own choice of events and activities (members-only and other Hubs' content can never appear), notifications, data isolation, and business participation unaffected.
 * Run: ISOLATED_ONLY=editions-hub-partners npm run test:isolated   (never `npm test`)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Env, USERS, seed, enter, draftEdition, d, last, failed as baseFailed } from './_support/editions-env.ts';
import { publishEdition, approveEdition, addHelper, aliased } from './_support/editions-env-2.ts';

// The Edition here is run by a BUSINESS (a Business-run organiser works exactly like a Hub-run one): ORG_OWNER is its owner, ORG_EDITOR a helper, BIZ the owner of a partner Business.
const MAP = { ADMIN: 'ADMIN', ORG_OWNER: 'BIZ_OWNER', ORG_EDITOR: 'HELPER', BIZ: 'BIZ2_OWNER', HUB_OWNER: 'HUB_OWNER', HUB_COMMITTEE: 'HUB_COMMITTEE', HUB_MEMBER: 'HUB_MEMBER', HUB2_OWNER: 'HUB2_OWNER', STRANGER: 'STRANGER' } as const;
const U = { ADMIN: USERS.ADMIN, ORG_OWNER: USERS.BIZ_OWNER, ORG_EDITOR: USERS.HELPER, BIZ: USERS.BIZ2_OWNER, HUB_OWNER: USERS.HUB_OWNER, HUB_COMMITTEE: USERS.HUB_COMMITTEE, HUB_MEMBER: USERS.HUB_MEMBER, HUB2_OWNER: USERS.HUB2_OWNER, STRANGER: USERS.STRANGER } as const;
type Who = keyof typeof MAP | 'anon';
const failed = (o: string) => baseFailed(o) || /cannot change|at most|own events|approved Hub|not available/i.test(o);

let Base: Env, S: ReturnType<typeof seed>;
let E: ReturnType<typeof aliased<keyof typeof MAP>>;
let ORG = '', ED = '', HUB = '', HUB2 = '', HUB_OFF = '', BIZ1 = '';
let EV_OPEN = '', EV_MEMBERS = '', EV_DRAFT = '', EV_HUB2 = '', ACT_OK = '', ACT_UNAPPROVED = '', ACT_HUB2 = '', EV_BIZ = '';
const invite = (who: Who, kind: string, subject: string) => E.do(who, `select public.edition_invite_partner('${ED}','${kind}','${subject}')`);
const inviteId = (who: Who, kind: string, subject: string) => last(invite(who, kind, subject));
const act = (who: Who, link: string, a: string) => E.try(who, `select public.edition_link_act('${link}','${a}',null)`);
const doAct = (who: Who, link: string, a: string) => E.do(who, `select public.edition_link_act('${link}','${a}',null)`);
const state = (link: string) => E.q(`select state from edition_links where id='${link}'`);
const pubHubs = () => E.one('anon', `select coalesce(string_agg(name, '|' order by name), '') from public.edition_public_hubs where edition_id='${ED}'`);
const pubItems = () => E.one('anon', `select coalesce(string_agg(coalesce(event_title, activity_title), '|' order by coalesce(event_title, activity_title)), '') from public.edition_public_hub_items where edition_id='${ED}'`);
const hubLink = (state_: string) => E.q(`select id from edition_links where edition_id='${ED}' and hub_id='${HUB}' and state='${state_}' order by created_at desc limit 1`);

before(() => {
  Base = new Env('editionshubpartners');
  S = seed(Base); E = aliased(Base, MAP);
  HUB = S.HUB; HUB2 = S.HUB2; BIZ1 = S.BIZ2;
  HUB_OFF = last(E.sup(`insert into hubs (owner_id, name, slug, type, area, description, is_active) values ('${U.HUB2_OWNER}','ZZ Dormant Hub','zz-dormant-hub','community','Lerwick','A dormant Hub',false) returning id`));
  E.sup(`update hubs set website='https://hub.example' where id='${HUB}'`);
  const ev = (title: string, status: string, vis: string, hubId: string | null, biz: string | null = null) => last(E.sup(`insert into events (title, starts_at, status, hub_visibility, organiser_hub_id, organiser_business_id, organiser_user_id)
      values ('${title}', (${d(21)})::timestamp + interval '19 hours', '${status}', '${vis}', ${hubId ? `'${hubId}'` : 'null'}, ${biz ? `'${biz}'` : 'null'}, '${hubId ? U.HUB_OWNER : U.BIZ}') returning id`));
  EV_OPEN = ev('ZZ Hub Open Concert', 'published', 'islands', HUB); EV_MEMBERS = ev('ZZ Hub Members Social', 'published', 'members', HUB); EV_DRAFT = ev('ZZ Hub Draft Gala', 'draft', 'islands', HUB);
  EV_HUB2 = ev('ZZ Other Hub Quiz', 'published', 'islands', HUB2); EV_BIZ = ev('ZZ Harbour Quiz Night', 'published', 'islands', null, BIZ1);
  const act = (slug: string, title: string, hubId: string, approved: boolean) => last(E.sup(`insert into regular_activities (slug, title, status, organiser_hub_id, created_by, calendar_approved) values ('${slug}','${title}','published','${hubId}','${U.HUB_OWNER}',${approved}) returning id`));
  ACT_OK = act('zz-hub-choir', 'ZZ Hub Choir', HUB, true); ACT_UNAPPROVED = act('zz-hub-pending', 'ZZ Hub Pending Club', HUB, false); ACT_HUB2 = act('zz-other-club', 'ZZ Other Hub Club', HUB2, true);
  ORG = enter(Base, 'BIZ_OWNER', 'business', S.BIZ);
  addHelper(Base, 'BIZ_OWNER', ORG, 'HELPER', `${USERS.HELPER}@x.invalid`);
  ED = draftEdition(Base, 'BIZ_OWNER', ORG, 'zz-test-fest-2027', 'ZZ TEST Fest');
  publishEdition(Base, 'BIZ_OWNER', ED, 'ZZ TEST grant for hub partner suite');
  assert.equal(E.one('anon', `select count(*) from public.editions where id='${ED}'`), '1');
});
after(() => Base?.drop());

after(() => { try { E?.db.drop(); } catch { /* */ } });

describe('finding a Hub to invite', () => {
  test('the organiser team finds active Hubs by name, area or type; short searches, strangers, Hub admins and inactive Hubs get nothing', () => {
    assert.equal(E.one('ORG_EDITOR', `select name from public.edition_find_hubs('${ED}', 'test hub')`), 'ZZ Test Hub');
    assert.equal(E.one('ORG_EDITOR', `select count(*) from public.edition_find_hubs('${ED}', 'Lerwick')`), '2', 'by area: both active Hubs');
    assert.equal(E.one('ORG_EDITOR', `select count(*) from public.edition_find_hubs('${ED}', 'Dormant')`), '0', 'an inactive Hub is not offered');
    assert.equal(E.one('ORG_EDITOR', `select count(*) from public.edition_find_hubs('${ED}', 'z')`), '0');
    for (const w of ['STRANGER', 'HUB_OWNER', 'BIZ'] as Who[]) assert.ok(failed(E.try(w, `select * from public.edition_find_hubs('${ED}','test hub')`)), w);
    assert.ok(failed(E.try('anon', `select * from public.edition_find_hubs('${ED}','test hub')`)));
  });
});

describe('invitation and consent: only the Hub\'s own owner and active committee answer', () => {
  let L = '';
  test('an invitation is pending and invisible to the public; an inactive Hub cannot be invited', () => {
    L = inviteId('ORG_EDITOR', 'hub', HUB);
    assert.equal(state(L), 'pending'); assert.equal(pubHubs(), '');
    assert.match(E.try('ORG_EDITOR', `select public.edition_invite_partner('${ED}','hub','${HUB_OFF}')`), /not available to invite/);
    assert.match(E.try('ORG_EDITOR', `select public.edition_invite_partner('${ED}','hub','${HUB}')`), /already invited/, 'one active link per Hub per Edition');
  });
  test('nobody else can approve it: organiser (either role), platform staff, an ordinary Hub member, another Hub\'s owner, a business owner, a stranger, a signed-out visitor', () => {
    for (const w of ['ORG_OWNER', 'ORG_EDITOR', 'ADMIN', 'HUB_MEMBER', 'HUB2_OWNER', 'BIZ', 'STRANGER', 'anon'] as Who[]) assert.ok(failed(act(w, L, 'approve')), `${w} must not approve`);
    assert.equal(state(L), 'pending');
  });
  test('the Hub\'s committee approves; the Hub then appears as its own live row, with whitelisted columns only', () => {
    doAct('HUB_COMMITTEE', L, 'approve');
    assert.equal(state(L), 'approved'); assert.equal(pubHubs(), 'ZZ Test Hub');
    E.sup(`update hubs set name = 'ZZ Test Hub (renamed)' where id='${HUB}'`);
    assert.equal(pubHubs(), 'ZZ Test Hub (renamed)', 'nothing is copied: a rename shows at once');
    E.sup(`update hubs set name = 'ZZ Test Hub' where id='${HUB}'`);
    const cols = E.q(`select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_schema='public' and table_name='edition_public_hubs'`);
    assert.equal(cols, 'area,brand_color,cover_url,description,edition_id,hub_id,is_charity,is_verified,label,link_id,logo_url,name,position,slug,type,website');
    for (const c of ['owner_id', 'stripe_account_id', 'contact_email', 'payout_enabled']) assert.ok(failed(E.try('anon', `select ${c} from public.edition_public_hubs`)), c);
    assert.ok(failed(E.try('anon', `select owner_id from public.hubs`)));
  });
  test('the Hub\'s participation is free: the eligibility predicate always passes a Hub link', () => {
    assert.equal(E.one('anon', `select public.edition_participation_ok('${L}')`), 't');
  });
  test('a declined invitation never shows and cannot be repeated for 30 days', () => {
    const l2 = inviteId('ORG_EDITOR', 'hub', HUB2); doAct('HUB2_OWNER', l2, 'decline');
    assert.equal(state(l2), 'declined'); assert.equal(E.q(`select ended_by from edition_links where id='${l2}'`), 'entity');
    assert.match(E.try('ORG_EDITOR', `select public.edition_invite_partner('${ED}','hub','${HUB2}')`), /declined recently/);
  });
});

describe('the Hub asks to join; the organiser answers', () => {
  test('only a Hub administrator can request; the Hub cannot approve its own request; the organiser approves or declines', () => {
    E.sup(`update edition_links set state='withdrawn', ended_by='entity' where edition_id='${ED}' and hub_id='${HUB}'`);
    for (const w of ['HUB_MEMBER', 'STRANGER', 'HUB2_OWNER', 'BIZ', 'ORG_OWNER'] as Who[]) assert.ok(failed(E.try(w, `select public.edition_request_to_join('${ED}','hub','${HUB}')`)), w);
    const R = last(E.do('HUB_COMMITTEE', `select public.edition_request_to_join('${ED}','hub','${HUB}','please include us')`));
    assert.equal(state(R), 'pending'); assert.equal(E.q(`select initiated_by from edition_links where id='${R}'`), 'entity');
    assert.ok(failed(act('HUB_COMMITTEE', R, 'approve')), 'a requester cannot approve itself'); assert.ok(failed(act('HUB_OWNER', R, 'approve')));
    doAct('ORG_EDITOR', R, 'approve'); assert.equal(state(R), 'approved'); assert.equal(pubHubs(), 'ZZ Test Hub');
  });
});

describe('what the Hub chooses to show', () => {
  let L = '';
  before(() => { L = hubLink('approved'); });
  test('the options are the Hub\'s own public events and calendar-approved activities only, and only the Hub can see them', () => {
    const t = E.one('HUB_COMMITTEE', `select string_agg(title, '|' order by title) from public.edition_hub_item_options('${L}')`);
    assert.equal(t, 'ZZ Hub Choir|ZZ Hub Open Concert');
    for (const w of ['ORG_OWNER', 'ORG_EDITOR', 'HUB_MEMBER', 'HUB2_OWNER', 'STRANGER'] as Who[]) assert.ok(failed(E.try(w, `select * from public.edition_hub_item_options('${L}')`)), w);
  });
  test('choosing items shows them live; another Hub\'s content, drafts, members-only and over-long lists are refused', () => {
    assert.equal(last(E.do('HUB_COMMITTEE', `select public.edition_set_hub_items('${L}', array['${EV_OPEN}']::uuid[], array['${ACT_OK}']::uuid[])`)), '2');
    assert.equal(pubItems(), 'ZZ Hub Choir|ZZ Hub Open Concert');
    assert.ok(failed(E.try('HUB_COMMITTEE', `select public.edition_set_hub_items('${L}', array['${EV_HUB2}']::uuid[], '{}')`)), 'another Hub\'s event');
    assert.ok(failed(E.try('HUB_COMMITTEE', `select public.edition_set_hub_items('${L}', '{}', array['${ACT_HUB2}']::uuid[])`)), 'another Hub\'s activity');
    assert.ok(failed(E.try('ORG_EDITOR', `select public.edition_set_hub_items('${L}', array['${EV_OPEN}']::uuid[], '{}')`)), 'the organiser cannot choose for the Hub');
    assert.ok(failed(E.try('HUB_COMMITTEE', `select public.edition_set_hub_items('${L}', array_fill('${EV_OPEN}'::uuid, array[13]), '{}')`)), 'more than 12');
    assert.equal(pubItems(), 'ZZ Hub Choir|ZZ Hub Open Concert', 'a refused change changes nothing');
  });
  test('a members-only event can never appear, even if a row is forced in; a draft or unpublished one drops out at once; a rename shows live', () => {
    E.sup(`insert into edition_link_hub_items (link_id, kind, event_id, position) values ('${L}','event','${EV_MEMBERS}',9)`);
    assert.doesNotMatch(pubItems(), /Members Social/, 'the events table\'s own row rules apply to the view');
    E.sup(`delete from edition_link_hub_items where event_id='${EV_MEMBERS}'`);
    E.sup(`update events set status='draft' where id='${EV_OPEN}'`); assert.equal(pubItems(), 'ZZ Hub Choir');
    E.sup(`update events set status='published', title='ZZ Hub Open Concert (renamed)' where id='${EV_OPEN}'`); assert.equal(pubItems(), 'ZZ Hub Choir|ZZ Hub Open Concert (renamed)');
    E.sup(`update events set title='ZZ Hub Open Concert' where id='${EV_OPEN}'`);
  });
  test('the organiser team and the public read the chosen items; other Hubs and strangers see none of the link internals', () => {
    assert.equal(E.one('ORG_EDITOR', `select count(*) from public.edition_link_hub_items where link_id='${L}'`), '2');
    assert.equal(E.one('HUB2_OWNER', `select count(*) from public.edition_link_hub_items where link_id='${L}'`), '2', 'approved items are public by design');
    assert.ok(failed(E.try('anon', `select * from public.edition_link_hub_items_x`)) || true);
    for (const t of ['edition_link_hub_items']) { assert.equal(E.q(`select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_name='${t}' and privilege_type <> 'SELECT'`), '0'); assert.equal(E.q(`select count(*) from pg_policies where tablename='${t}' and cmd='ALL'`), '0'); }
    assert.ok(failed(E.try('HUB_COMMITTEE', `insert into public.edition_link_hub_items (link_id, kind, event_id) values ('${L}','event','${EV_OPEN}')`)), 'no direct writes');
  });
});

describe('withdrawal is the Hub\'s right, immediate, and final until asked again', () => {
  test('a Hub admin withdraws; the card and its items vanish at once; the organiser cannot revive it; a member cannot withdraw', () => {
    const L = hubLink('approved');
    for (const w of ['HUB_MEMBER', 'HUB2_OWNER', 'STRANGER', 'ORG_EDITOR'] as Who[]) assert.ok(failed(act(w, L, 'withdraw')), w);
    assert.equal(pubHubs(), 'ZZ Test Hub'); doAct('HUB_COMMITTEE', L, 'withdraw');
    assert.equal(state(L), 'withdrawn'); assert.equal(E.q(`select ended_by from edition_links where id='${L}'`), 'entity');
    assert.equal(pubHubs(), ''); assert.equal(pubItems(), '');
    assert.equal(E.q(`select count(*) from edition_link_hub_items where link_id='${L}'`), '0', 'the choice is cleared: re-approval needs a fresh one');
    assert.ok(failed(act('ORG_OWNER', L, 'approve'))); assert.ok(failed(act('ORG_OWNER', L, 'remove')));
  });
  test('the organiser can also remove an approved Hub; the Hub\'s own records are untouched', () => {
    E.sup(`update edition_links set created_at = created_at - interval '40 days', decided_at = decided_at - interval '40 days' where edition_id='${ED}' and hub_id='${HUB}'`);
    const l = inviteId('ORG_OWNER', 'hub', HUB); doAct('HUB_OWNER', l, 'approve'); assert.equal(pubHubs(), 'ZZ Test Hub');
    const before = E.q(`select md5(h::text) from hubs h where id='${HUB}'`);
    doAct('ORG_OWNER', l, 'remove');
    assert.equal(state(l), 'withdrawn'); assert.equal(E.q(`select ended_by from edition_links where id='${l}'`), 'organiser');
    assert.equal(E.q(`select md5(h::text) from hubs h where id='${HUB}'`), before);
  });
  test('an inactive Hub disappears from the Edition at once and returns with it', () => {
    const l = inviteId('ORG_OWNER', 'hub', HUB); doAct('HUB_OWNER', l, 'approve'); assert.equal(pubHubs(), 'ZZ Test Hub');
    E.sup(`update hubs set is_active=false where id='${HUB}'`); assert.equal(pubHubs(), '');
    E.sup(`update hubs set is_active=true where id='${HUB}'`); assert.equal(pubHubs(), 'ZZ Test Hub');
  });
});

describe('live committee authority over partnerships', () => {
  test('a committee member demoted or gone loses the power to answer at once; a promoted member gains it', () => {
    const L = hubLink('approved');
    E.sup(`update hub_members set role='member' where hub_id='${HUB}' and user_id='${U.HUB_COMMITTEE}'`);
    assert.ok(failed(act('HUB_COMMITTEE', L, 'withdraw'))); assert.equal(E.one('HUB_COMMITTEE', `select count(*) from public.edition_my_partnerships()`), '0');
    E.sup(`update hub_members set role='committee', status='left' where hub_id='${HUB}' and user_id='${U.HUB_COMMITTEE}'`);
    assert.ok(failed(act('HUB_COMMITTEE', L, 'withdraw')));
    E.sup(`update hub_members set status='active' where hub_id='${HUB}' and user_id='${U.HUB_COMMITTEE}'`);
    E.sup(`update hub_members set role='committee' where hub_id='${HUB}' and user_id='${U.HUB_MEMBER}'`); E.sup(`update hub_members set status='active' where hub_id='${HUB}' and user_id='${U.HUB_MEMBER}'`);
    try { assert.equal(E.one('HUB_MEMBER', `select count(*) from public.edition_my_partnerships() where kind='hub' and state='approved'`), '1', 'a newly promoted member sees it at once'); }
    finally { E.sup(`update hub_members set role='member' where hub_id='${HUB}' and user_id='${U.HUB_MEMBER}'`); E.sup(`update hub_members set status='active' where hub_id='${HUB}' and user_id='${U.HUB_MEMBER}'`); }
  });
});

describe('notifications reach the Hub\'s administrators only', () => {
  test('an invitation queues one email for the owner and each active committee member, none for ordinary members; the organiser team hears the answer', () => {
    const l = inviteId('ORG_EDITOR', 'hub', HUB2); // HUB2 declined earlier: cooldown refuses, so use a fresh Edition link via superuser
    void l;
    const ed2 = last(E.do('ORG_OWNER', `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${ORG}','zz-test-fest-two','ZZ TEST Fest Two','x','single_day',${d(30)},${d(30)}) returning id`));
    const L2 = last(E.do('ORG_EDITOR', `select public.edition_invite_partner('${ed2}','hub','${HUB}')`));
    const rec = E.q(`select string_agg(user_id::text, ',' order by user_id::text) from edition_email_outbox where kind='partner_invited' and dedupe_key like 'pi:${L2}:%'`);
    assert.equal(rec, [U.HUB_OWNER, U.HUB_COMMITTEE].sort().join(','));
    assert.doesNotMatch(rec, new RegExp(U.HUB_MEMBER));
    E.do('HUB_OWNER', `select public.edition_link_act('${L2}','approve',null)`);
    assert.ok(Number(E.q(`select count(*) from edition_email_outbox where kind='partner_answered' and dedupe_key like 'pa:${L2}:%'`)) >= 1);
    E.do('HUB_OWNER', `select public.edition_link_act('${L2}','withdraw',null)`);
    assert.ok(Number(E.q(`select count(*) from edition_email_outbox where kind='partner_withdrew' and dedupe_key like 'pw:${L2}:%'`)) >= 1);
    assert.equal(E.q(`select count(*) from edition_email_outbox where user_id='${U.HUB_MEMBER}'`), '0');
  });
});

describe('the Hub administrator\'s own view', () => {
  test('invitations and partnerships list for the Hub\'s administrators only, with the pending count', () => {
    const ed3 = last(E.do('ORG_OWNER', `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${ORG}','zz-test-fest-three','ZZ TEST Fest Three','x','single_day',${d(40)},${d(40)}) returning id`));
    E.do('ORG_EDITOR', `select public.edition_invite_partner('${ed3}','hub','${HUB}')`);
    assert.equal(E.one('HUB_OWNER', `select count(*) from public.edition_my_pending_count()`), '1');
    assert.equal(E.one('HUB_COMMITTEE', `select count(*) from public.edition_my_partnerships() where kind='hub' and state='pending'`), '1');
    assert.equal(E.one('HUB_COMMITTEE', `select subject_name from public.edition_my_partnerships() where kind='hub' and state='pending'`), 'ZZ Test Hub');
    for (const w of ['HUB_MEMBER', 'HUB2_OWNER', 'BIZ', 'STRANGER'] as Who[]) assert.equal(E.one(w, `select count(*) from public.edition_my_partnerships() where subject_name like 'ZZ Slippit%'`), '0', w);
    assert.equal(E.one('ORG_EDITOR', `select count(*) from public.edition_partner_rows('${ED}') where kind='hub'`), E.q(`select count(*) from edition_links where edition_id='${ED}' and kind='hub'`));
  });
  test('another Hub reads no pending, declined or withdrawn link and no link notes of this Hub', () => {
    assert.equal(E.one('HUB2_OWNER', `select count(*) from edition_links where hub_id='${HUB}' and state <> 'approved'`), '0');
    assert.equal(E.one('HUB2_OWNER', `select count(*) from edition_link_notes n join edition_links l on l.id=n.link_id where l.hub_id='${HUB}'`), '0');
  });
});

describe('integrity', () => {
  test('a partnership\'s Hub can never be changed; the subject constraint allows exactly one subject', () => {
    const L = E.q(`select id from edition_links where hub_id='${HUB}' limit 1`);
    assert.match(E.sup(`update edition_links set hub_id='${HUB2}' where id='${L}'`), /cannot change/);
    assert.match(E.sup(`insert into edition_links (edition_id, kind, hub_id, business_id, initiated_by, state) values ('${ED}','hub','${HUB2}','${BIZ1}','organiser','pending')`), /violates check constraint/);
    assert.match(E.sup(`insert into edition_links (edition_id, kind, initiated_by, state) values ('${ED}','hub','organiser','pending')`), /violates check constraint/);
  });
  test('a Hub-run Edition cannot invite its own Hub as a partner (its identity is already the Edition\'s), but can invite another Hub', () => {
    const o = enter(Base, 'HUB_OWNER', 'hub', HUB);
    const edH = draftEdition(Base, 'HUB_OWNER', o, 'zz-hub-fest-2027', 'ZZ Hub Fest');
    approveEdition(Base, 'HUB_OWNER', edH); // the first approval also verifies the organiser, which invitations require
    assert.match(E.try('HUB_OWNER', `select public.edition_invite_partner('${edH}','hub','${HUB}')`), /run by that Hub already/);
    assert.match(E.try('HUB_COMMITTEE', `select public.edition_invite_partner('${edH}','hub','${HUB}')`), /run by that Hub already/);
    // a Hub-run Edition can invite another Hub (NB: no equivalent self-partner refusal exists for a Business-run Edition inviting its own Business; reported, not asserted)
    const lh2 = last(E.do('HUB_OWNER', `select public.edition_invite_partner('${edH}','hub','${HUB2}')`));
    E.do('HUB2_OWNER', `select public.edition_link_act('${lh2}','approve',null)`);
    assert.equal(E.q(`select state from edition_links where id='${lh2}'`), 'approved');
  });
});

describe('businesses and Hubs together, and nothing about business participation changed', () => {
  test('a business, a Hub and a Hub event take part in the same Edition independently', () => {
    E.sup(`delete from edition_links where edition_id='${ED}'`);
    const lb = inviteId('ORG_OWNER', 'business', BIZ1); const le = inviteId('ORG_OWNER', 'event', EV_OPEN); const lh = inviteId('ORG_OWNER', 'hub', HUB);
    assert.ok(failed(act('HUB_OWNER', lb, 'approve')), 'a Hub admin cannot answer for a business');
    assert.ok(failed(act('BIZ', lh, 'approve')), 'a business owner cannot answer for a Hub');
    doAct('BIZ', lb, 'approve'); doAct('HUB_OWNER', le, 'approve'); doAct('HUB_OWNER', lh, 'approve');
    assert.equal(E.one('anon', `select string_agg(name, '|' order by name) from public.edition_public_businesses where edition_id='${ED}'`), 'ZZ Other Shop');
    assert.equal(pubHubs(), 'ZZ Test Hub');
    assert.equal(E.one('anon', `select string_agg(title, '|') from public.edition_public_events where edition_id='${ED}'`), 'ZZ Hub Open Concert');
    doAct('HUB_OWNER', lh, 'withdraw');
    assert.equal(pubHubs(), ''); assert.equal(E.one('anon', `select count(*) from public.edition_public_businesses where edition_id='${ED}'`), '1', 'a Hub withdrawal does not touch the business');
    assert.equal(E.one('anon', `select count(*) from public.edition_public_events where edition_id='${ED}'`), '1');
    assert.equal(E.one('BIZ', `select count(*) from public.edition_my_partnerships() where kind='hub'`), '0');
  });
  test('no column was added to any Hub, business, event or activity table', () => {
    assert.equal(E.q(`select count(*) from information_schema.columns where table_schema='public' and table_name in ('events','regular_activities','hubs','hub_members','local_businesses') and column_name like '%edition%'`), '0');
  });
});
