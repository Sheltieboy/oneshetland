/**
 * editions-hub-addfrom.node.test.ts — ISOLATED Postgres only. Editions 1.1 "Add from your Hub": a Hub owner or active committee member adds the Hub's own
 * events and regular activities to a Hub-run Edition in one step. No invitation to themselves, no copy, the original keeps its ownership and privacy, later
 * changes to the original show in the Edition, and removing never deletes the original.
 * Run: ISOLATED_ONLY=editions-hub-addfrom npm run test:isolated   (never `npm test`)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const id = (n: number) => `${n.toString(16).padStart(2, '0')}000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, '0')}`;
const U = { ADMIN: id(1), HUB_OWNER: id(8), HUB_COMMITTEE: id(9), HUB_MEMBER: id(10), HUB2_OWNER: id(11), STRANGER: id(7), ORG_OWNER: id(3), ORG_EDITOR: id(4) } as const;
type Who = keyof typeof U | 'anon';
const rowsTag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (o: string) => o.split('\n').map((l) => l.trim()).filter((l) => l && !rowsTag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT|^WARNING|^NOTICE/.test(l));
const last = (o: string) => rowsOf(o).pop() ?? '';
const failed = (o: string) => /^ERROR:|permission denied|row-level security|violates|not permitted|not found|only the|already|not run by a Hub/im.test(o);

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
let HUB = '', HUB2 = '', ORG = '', ED = '', ED_PLAIN = '';
let EV_OPEN = '', EV_HUBONLY = '', EV_MEMBERS = '', EV_DRAFT = '', EV_OUTSIDE = '', EV_HUB2 = '', ACT_OK = '', ACT_PAUSED = '', ACT_UNAPPROVED = '';
const d = (n: number) => `(current_date + ${n})`;
const items = (who: Who, ed = ED) => E.one(who, `select coalesce(string_agg(kind || ':' || title || ':' || (link_id is not null)::text, '|' order by kind, title), '') from public.edition_hub_own_items('${ed}')`);
const add = (who: Who, kind: string, subject: string) => E.do(who, `select public.edition_invite_partner('${ED}','${kind}','${subject}')`);
const publicEvents = () => E.one('anon', `select coalesce(string_agg(title, '|' order by title), '') from public.edition_public_events where edition_id='${ED}'`);
const publicActs = () => E.one('anon', `select coalesce(string_agg(title, '|' order by title), '') from public.edition_public_activities where edition_id='${ED}'`);
const linkOf = (kind: 'event' | 'activity', subject: string) => E.q(`select id from edition_links where edition_id='${ED}' and ${kind}_id='${subject}' and state in ('pending','approved')`);

before(() => {
  E = new Env();
  E.db = createReplayDb('editionsaddfromhub');
  E.sup(`alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated;`);
  const ids = Object.values(U).map((u) => `'${u}'::uuid`).join(',');
  E.sup(`insert into auth.users (id, email) select x, x::text || '@x.invalid' from unnest(array[${ids}]) x on conflict do nothing;
    insert into profiles (id, role, full_name) values ('${U.ADMIN}','admin','Zed Admin'),('${U.HUB_OWNER}','customer','Hana Hub'),('${U.HUB_COMMITTEE}','customer','Colm Committee'),('${U.HUB_MEMBER}','customer','Mia Member'),
      ('${U.HUB2_OWNER}','customer','Hugh Other'),('${U.STRANGER}','customer','Sam Stranger'),('${U.ORG_OWNER}','customer','Orla Organiser'),('${U.ORG_EDITOR}','customer','Eddie Editor')
      on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;
    insert into admin_config (key, value, category) values ('editions.enabled','true','features') on conflict (key) do update set value='true';`);
  const hub = (owner: string, name: string, slug: string) => last(E.sup(`insert into hubs (owner_id, name, slug, type, is_active) values ('${owner}','${name}','${slug}','community',true) returning id`));
  HUB = hub(U.HUB_OWNER, 'ZZ Slippit Hub', 'zz-slippit-hub'); HUB2 = hub(U.HUB2_OWNER, 'ZZ Other Hub', 'zz-other-hub');
  E.sup(`insert into hub_members (hub_id, user_id, role, status) values ('${HUB}','${U.HUB_COMMITTEE}','committee','active'),('${HUB}','${U.HUB_MEMBER}','member','active') on conflict do nothing`);
  const ev = (title: string, status: string, vis: string, hubId: string, day: number, hidden = false) => last(E.sup(`insert into events (title, starts_at, status, hub_visibility, organiser_hub_id, organiser_user_id, is_hidden)
      values ('${title}', (${d(day)})::timestamp + interval '19 hours', '${status}', '${vis}', '${hubId}', '${U.HUB_OWNER}', ${hidden}) returning id`));
  EV_OPEN = ev('ZZ Open Concert', 'published', 'islands', HUB, 11); EV_HUBONLY = ev('ZZ Hub Only Meeting', 'published', 'hub', HUB, 11);
  EV_MEMBERS = ev('ZZ Members Social', 'published', 'members', HUB, 11); EV_DRAFT = ev('ZZ Draft Gala', 'draft', 'islands', HUB, 11);
  EV_OUTSIDE = ev('ZZ Outside Dates Event', 'published', 'islands', HUB, 40);
  EV_HUB2 = ev('ZZ Other Hub Quiz', 'published', 'islands', HUB2, 11);
  const act = (slug: string, title: string, extra: string) => last(E.sup(`insert into regular_activities (slug, title, status, organiser_hub_id, created_by, calendar_approved ${extra.split('|')[0]}) values ('${slug}','${title}','published','${HUB}','${U.HUB_OWNER}', ${extra.split('|')[1]}) returning id`));
  ACT_OK = act('zz-choir', 'ZZ Hub Choir', '|true'); ACT_PAUSED = act('zz-paused', 'ZZ Paused Club', ', admin_paused|true, true'); ACT_UNAPPROVED = act('zz-unapproved', 'ZZ Unapproved Club', '|false');
  ORG = last(E.do('HUB_OWNER', `select public.create_edition_organiser_for_hub('${HUB}','zz-slippit-festivals','ZZ Slippit Festivals')`));
  E.do('HUB_OWNER', `select public.request_edition_organiser_verification('${ORG}', 'ZZ TEST committee evidence')`);
  E.do('ADMIN', `select public.admin_decide_edition_organiser('${ORG}', 'verify', 'ok ok ok ok')`);
  ED = last(E.do('HUB_COMMITTEE', `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${ORG}','zz-slippit-fest','ZZ Slippit Fest','A festival.','multi_day',${d(10)},${d(13)}) returning id`));
  E.do('ADMIN', `select public.admin_grant_edition_entitlement('${ED}', 'publish', now(), now() + interval '90 days', 'ZZ TEST grant for add-from-hub suite')`);
  E.do('HUB_COMMITTEE', `select public.edition_set_status('${ED}', 'published')`);
  // a plain (not Hub-run) organiser and Edition, with an explicit team Editor
  const PORG = last(E.do('ORG_OWNER', `select public.create_edition_organiser('ZZ TEST Festival Co.', 'zz-test-festival-co', 'tag')`));
  E.do('ORG_OWNER', `select public.invite_edition_member('${PORG}', '${U.ORG_EDITOR}@x.invalid', 'editor')`);
  E.do('ORG_EDITOR', `select public.accept_edition_invite('${E.q(`select id from edition_organiser_invites where organiser_id='${PORG}'`)}')`);
  ED_PLAIN = last(E.do('ORG_OWNER', `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${PORG}','zz-plain-fest','ZZ Plain Fest','A festival.','multi_day',${d(10)},${d(13)}) returning id`));
  // an explicit team Editor on the Hub-run organiser who is NOT on the Hub's committee
  E.do('HUB_OWNER', `select public.invite_edition_member('${ORG}', '${U.ORG_EDITOR}@x.invalid', 'editor')`);
  E.do('ORG_EDITOR', `select public.accept_edition_invite('${E.q(`select id from edition_organiser_invites where organiser_id='${ORG}' order by created_at desc limit 1`)}')`);
});
after(() => { try { E?.db.drop(); } catch { /* */ } });

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
    for (const w of ['HUB_MEMBER', 'STRANGER', 'HUB2_OWNER', 'ORG_EDITOR'] as Who[]) assert.ok(failed(E.try(w, `select * from public.edition_hub_own_items('${ED}')`)), w);
    assert.ok(failed(E.try('anon', `select * from public.edition_hub_own_items('${ED}')`)));
  });
  test('an Edition that is not Hub-run has nothing to offer', () => {
    assert.match(E.try('ORG_OWNER', `select * from public.edition_hub_own_items('${ED_PLAIN}')`), /not run by a Hub/);
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
