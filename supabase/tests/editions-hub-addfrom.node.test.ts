/**
 * editions-hub-addfrom.node.test.ts — ISOLATED Postgres only. Editions 1.1 "Add from your Hub": a Hub owner or active committee member adds the Hub's own
 * events and regular activities to a Hub-run Edition in one step. No invitation to themselves, no copy, the original keeps its ownership and privacy, later
 * changes to the original show in the Edition, and removing never deletes the original.
 * Run: ISOLATED_ONLY=editions-hub-addfrom npm run test:isolated   (never `npm test`)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Env, USERS, seed, enter, draftEdition, d, last, failed as baseFailed, type Who as BaseWho } from './_support/editions-env.ts';
import { publishEdition, addHelper } from './_support/editions-env-2.ts';

// ORG_OWNER is the Business owner (a Business-run organiser is the "not Hub-run" case); ORG_EDITOR is a helper who is not on the Hub's committee
const U = { ADMIN: USERS.ADMIN, HUB_OWNER: USERS.HUB_OWNER, HUB_COMMITTEE: USERS.HUB_COMMITTEE, HUB_MEMBER: USERS.HUB_MEMBER, HUB2_OWNER: USERS.HUB2_OWNER, STRANGER: USERS.STRANGER, ORG_OWNER: USERS.BIZ_OWNER, ORG_EDITOR: USERS.HELPER } as const;
type Who = keyof typeof U | 'anon';
const failed = (o: string) => baseFailed(o) || /not run by a Hub/i.test(o);
const as = (w: Who): BaseWho => (w === 'ORG_OWNER' ? 'BIZ_OWNER' : w === 'ORG_EDITOR' ? 'HELPER' : w);

let E: Env;
let HUB = '', HUB2 = '', ORG = '', ED = '', ED_PLAIN = '';
let EV_OPEN = '', EV_HUBONLY = '', EV_MEMBERS = '', EV_DRAFT = '', EV_OUTSIDE = '', EV_HUB2 = '', ACT_OK = '', ACT_PAUSED = '', ACT_UNAPPROVED = '';
const items = (who: Who, ed = ED) => E.one(as(who), `select coalesce(string_agg(kind || ':' || title || ':' || (link_id is not null)::text, '|' order by kind, title), '') from public.edition_hub_own_items('${ed}')`);
const add = (who: Who, kind: string, subject: string) => E.do(as(who), `select public.edition_invite_partner('${ED}','${kind}','${subject}')`);
const publicEvents = () => E.one('anon', `select coalesce(string_agg(title, '|' order by title), '') from public.edition_public_events where edition_id='${ED}'`);
const publicActs = () => E.one('anon', `select coalesce(string_agg(title, '|' order by title), '') from public.edition_public_activities where edition_id='${ED}'`);
const linkOf = (kind: 'event' | 'activity', subject: string) => E.q(`select id from edition_links where edition_id='${ED}' and ${kind}_id='${subject}' and state in ('pending','approved')`);

let S: ReturnType<typeof seed>;
before(() => {
  E = new Env('editionsaddfromhub');
  S = seed(E);
  HUB = S.HUB; HUB2 = S.HUB2;
  const ev = (title: string, status: string, vis: string, hubId: string, day: number, hidden = false) => last(E.sup(`insert into events (title, starts_at, status, hub_visibility, organiser_hub_id, organiser_user_id, is_hidden)
      values ('${title}', (${d(day)})::timestamp + interval '19 hours', '${status}', '${vis}', '${hubId}', '${U.HUB_OWNER}', ${hidden}) returning id`));
  EV_OPEN = ev('ZZ Open Concert', 'published', 'islands', HUB, 21); EV_HUBONLY = ev('ZZ Hub Only Meeting', 'published', 'hub', HUB, 21);
  EV_MEMBERS = ev('ZZ Members Social', 'published', 'members', HUB, 21); EV_DRAFT = ev('ZZ Draft Gala', 'draft', 'islands', HUB, 21);
  EV_OUTSIDE = ev('ZZ Outside Dates Event', 'published', 'islands', HUB, 40);
  EV_HUB2 = ev('ZZ Other Hub Quiz', 'published', 'islands', HUB2, 21);
  const act = (slug: string, title: string, extra: string) => last(E.sup(`insert into regular_activities (slug, title, status, organiser_hub_id, created_by, calendar_approved ${extra.split('|')[0]}) values ('${slug}','${title}','published','${HUB}','${U.HUB_OWNER}', ${extra.split('|')[1]}) returning id`));
  ACT_OK = act('zz-choir', 'ZZ Hub Choir', '|true'); ACT_PAUSED = act('zz-paused', 'ZZ Paused Club', ', admin_paused|true, true'); ACT_UNAPPROVED = act('zz-unapproved', 'ZZ Unapproved Club', '|false');
  ORG = enter(E, 'HUB_OWNER', 'hub', HUB);
  ED = draftEdition(E, 'HUB_COMMITTEE', ORG, 'zz-slippit-fest', 'ZZ Slippit Fest');
  publishEdition(E, 'HUB_COMMITTEE', ED, 'ZZ TEST grant for add-from-hub suite');
  // a Business-run (not Hub-run) organiser and Edition, with an explicit team Editor
  const PORG = enter(E, 'BIZ_OWNER', 'business', S.BIZ);
  addHelper(E, 'BIZ_OWNER', PORG, 'HELPER', `${USERS.HELPER}@x.invalid`);
  ED_PLAIN = draftEdition(E, 'BIZ_OWNER', PORG, 'zz-plain-fest', 'ZZ Plain Fest');
  // the same helper is also an explicit team Editor on the Hub-run organiser but NOT on the Hub's committee
  addHelper(E, 'HUB_OWNER', ORG, 'HELPER', `${USERS.HELPER}@x.invalid`);
});
after(() => E?.drop());

describe('what the chooser offers', () => {
  test('the Hub owner and an active committee member see the same eligible events and activities, none of them added yet', () => {
    const want = 'activity:ZZ Hub Choir:false|event:ZZ Hub Only Meeting:false|event:ZZ Open Concert:false';
    assert.equal(items('HUB_OWNER'), want); assert.equal(items('HUB_COMMITTEE'), want);
  });
  test('members-only, draft, out-of-dates, other-Hub events and paused or unapproved activities are never offered', () => {
    const t = items('HUB_OWNER');
    for (const bad of ['Members Social', 'Draft Gala', 'Outside Dates', 'Other Hub Quiz', 'Paused Club', 'Unapproved Club']) assert.doesNotMatch(t, new RegExp(bad), bad);
  });
  test('a Hub member, a stranger, another Hub, anon and a team Editor who is not on the committee are refused', () => {
    for (const w of ['HUB_MEMBER', 'STRANGER', 'HUB2_OWNER', 'ORG_EDITOR'] as Who[]) assert.ok(failed(E.try(as(w), `select * from public.edition_hub_own_items('${ED}')`)), w);
    assert.ok(failed(E.try('anon', `select * from public.edition_hub_own_items('${ED}')`)));
  });
  test('an Edition that is not Hub-run has nothing to offer', () => {
    assert.match(E.try('BIZ_OWNER', `select * from public.edition_hub_own_items('${ED_PLAIN}')`), /not run by a Hub/);
  });
});

describe('adding, changing and removing', () => {
  test('adding needs no invitation: it is approved at once, nothing waits for anyone, and no copy of the event is made', () => {
    const before = E.q(`select count(*) from events`);
    const l = last(add('HUB_COMMITTEE', 'event', EV_OPEN));
    assert.equal(E.q(`select state from edition_links where id='${l}'`), 'approved');
    assert.equal(E.q(`select count(*) from edition_links where edition_id='${ED}' and state='pending'`), '0');
    assert.equal(E.q(`select count(*) from events`), before, 'no duplicate event');
    assert.match(items('HUB_OWNER'), /event:ZZ Open Concert:true/);
    last(add('HUB_OWNER', 'activity', ACT_OK));
    assert.equal(publicEvents(), 'ZZ Open Concert'); assert.equal(publicActs(), 'ZZ Hub Choir');
  });
  test('adding the same item twice is refused', () => { assert.ok(failed(E.try('HUB_OWNER', `select public.edition_invite_partner('${ED}','event','${EV_OPEN}')`))); });
  test('a Hub event cannot be added to an Edition by someone who does not control it: it becomes an ordinary invitation', () => {
    const l = last(add('ORG_EDITOR', 'event', EV_HUBONLY));
    assert.equal(E.q(`select state from edition_links where id='${l}'`), 'pending', 'consent still required');
    E.sup(`delete from edition_links where id='${l}'`);
  });
  test('the original keeps its owner, visibility and status through add', () => {
    assert.equal(E.q(`select organiser_hub_id::text || '|' || hub_visibility || '|' || status || '|' || organiser_user_id::text from events where id='${EV_OPEN}'`), `${HUB}|islands|published|${U.HUB_OWNER}`);
  });
  test('changes to the original are reflected in the Edition; making it members-only or un-publishing it removes it from the public page', () => {
    E.sup(`update events set title='ZZ Open Concert (new time)' where id='${EV_OPEN}'`);
    assert.equal(publicEvents(), 'ZZ Open Concert (new time)');
    E.sup(`update events set hub_visibility='members' where id='${EV_OPEN}'`); assert.equal(publicEvents(), '', 'members-only stays private');
    E.sup(`update events set hub_visibility='islands', status='draft' where id='${EV_OPEN}'`); assert.equal(publicEvents(), '', 'an un-published event disappears');
    assert.doesNotMatch(items('HUB_OWNER'), /Open Concert/, 'and is no longer offered');
    E.sup(`update events set status='published', title='ZZ Open Concert' where id='${EV_OPEN}'`); assert.equal(publicEvents(), 'ZZ Open Concert');
  });
  test('removing takes it off the Edition but never deletes the original; it can be added again', () => {
    const l = linkOf('event', EV_OPEN);
    E.do('HUB_COMMITTEE', `select public.edition_link_act('${l}','remove',null)`);
    assert.equal(publicEvents(), '');
    assert.equal(E.q(`select count(*) from events where id='${EV_OPEN}' and status='published' and not is_hidden`), '1');
    assert.match(items('HUB_OWNER'), /event:ZZ Open Concert:false/);
    last(add('HUB_COMMITTEE', 'event', EV_OPEN)); assert.equal(publicEvents(), 'ZZ Open Concert');
  });
  test('removing a committee member from the Hub removes their ability to use the chooser straight away', () => {
    E.sup(`update hub_members set status='removed' where hub_id='${HUB}' and user_id='${U.HUB_COMMITTEE}'`);
    assert.ok(failed(E.try('HUB_COMMITTEE', `select * from public.edition_hub_own_items('${ED}')`)));
    E.sup(`update hub_members set status='active' where hub_id='${HUB}' and user_id='${U.HUB_COMMITTEE}'`);
  });
});

describe('exposure', () => {
  test('the chooser is executable by signed-in users only; the anon-executable Editions function count is unchanged', () => {
    assert.equal(E.q(`select has_function_privilege('anon','public.edition_hub_own_items(uuid)','execute')::text`), 'false');
    assert.equal(E.q(`select has_function_privilege('authenticated','public.edition_hub_own_items(uuid)','execute')::text`), 'true');
  });
});
