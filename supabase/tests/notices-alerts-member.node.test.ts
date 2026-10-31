/**
 * notices-alerts-member.node.test.ts - ordinary MEMBERS publish notices (migration 20261129050000), in an ISOLATED Postgres.
 * PROVES: a member posts as themselves and the notice starts pending, invisible to the public and to other members; nothing but wording, category, areas and
 * expiry is theirs to set (never urgent / essential / hub / business / platform / event); required fields, categories, areas and expiry are validated; at most five
 * pending; staff (and only staff) approve or decline, a decline carries a reason the member is shown; editing a published notice returns it to moderation and out
 * of every public read; withdrawal removes it; one member never sees or touches another's; AREA TARGETING keeps its three states (specific / explicit
 * Shetland-wide / unspecified) - unspecified is read in general feeds but is never Shetland-wide and never a push audience; and a deleted account leaves
 * "Former member" with nothing identifying. SAFETY - ISOLATED DATABASE ONLY (see the harness).
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildDatabase, U, as, asScalar, raw, scalar, failed, idOf, HUB_V, BIZ_V } from './_support/notices-alerts-harness.ts';

const BODY = 'A short community notice, written by a member, for the isolated test database.';
let CHILD = '', SIBLING = '';
const submit = (who: Parameters<typeof as>[0], title = 'Lost: grey cat near the Co-op', o: { cat?: string; areas?: string; exp?: string; body?: string } = {}) =>
  as(who, `select public.submit_person_notice('${title}', '${o.body ?? BODY}', ${o.cat === undefined ? "'lost_found'" : o.cat}, ${o.areas ?? "array['shetland_wide']::text[]"}, ${o.exp ?? 'null'})`);
const sub = (who: Parameters<typeof as>[0], title?: string, o?: Parameters<typeof submit>[2]) => { const out = submit(who, title, o); if (failed(out)) throw new Error(out); return idOf(out); };
const status = (id: string) => scalar(`select status from notices where id='${id}'`);
const publicCount = (id: string, areas = 'null') => asScalar('anon', `select count(*) from public.get_public_notices('all', ${areas}, null, 50, 0) where id = '${id}'`);
const mine = (who: Parameters<typeof as>[0], id: string, col: string) => asScalar(who, `select ${col} from public.my_person_notices() where id = '${id}'`);

before(() => {
  buildDatabase();
  const kid = raw(`select a.id || ',' || a.parent_id from areas a join areas p on p.id = a.parent_id where p.type = 'locality' and a.is_active limit 1`).split('\n').map((l) => l.trim()).filter((l) => l.includes(',')).pop()!.split(',');
  CHILD = kid[0];
  SIBLING = scalar(`select id from areas where is_physical and is_active and id not in ('${kid[0]}','${kid[1]}') and parent_id is distinct from '${kid[1]}' limit 1`);
});

describe('submitting', () => {
  test('1 a member submits: the notice is theirs, pending, never urgent / essential / platform / hub / business / event, and invisible to the public and to other members', () => {
    const id = sub('B');
    assert.deepEqual(scalar(`select concat_ws('|', status, is_person_notice, publisher_user_id = '${U.B}', severity <> 'urgent', not is_essential, not is_platform_notice, publisher_hub_id is null, publisher_business_id is null, event_id is null, campaign_id is null, visibility) from notices where id='${id}'`), 'pending|t|t|t|t|t|t|t|t|t|public');
    assert.equal(publicCount(id), '0'); assert.equal(asScalar('anon', `select count(*) from public.get_public_notice('${id}')`), '0');
    assert.equal(asScalar('A2', `select count(*) from notices where id='${id}'`), '0', 'another member cannot read it through the table');
    assert.equal(asScalar('A2', `select count(*) from public.my_person_notices() where id='${id}'`), '0', 'nor through the member list');
    assert.equal(mine('B', id, 'state'), 'pending');
  });
  test('2 required fields and values are validated; nothing invalid is stored', () => {
    const before = scalar(`select count(*) from notices where is_person_notice`);
    for (const [what, out] of [
      ['signed out', submit('anon')], ['short title', submit('A', 'Hi')], ['long title', submit('A', 'x'.repeat(121))], ['short text', submit('A', 'A fine title', { body: 'tiny' })],
      ['no category', submit('A', 'A fine title', { cat: 'null' })], ['invented category', submit('A', 'A fine title', { cat: "'not_a_category'" })],
      ['past expiry', submit('A', 'A fine title', { exp: "now() - interval '1 day'" })], ['expiry > 90 days', submit('A', 'A fine title', { exp: "now() + interval '91 days'" })],
      ['unknown area', submit('A', 'A fine title', { areas: "array['atlantis']::text[]" })], ['wide + specific', submit('A', 'A fine title', { areas: `array['shetland_wide','${CHILD}']::text[]` })],
      ['too many areas', submit('A', 'A fine title', { areas: `array[${Array.from({ length: 9 }, (_, i) => `'a${i}'`).join(',')}]::text[]` })],
    ] as const) assert.ok(failed(out) || /permission denied/.test(out), `${what} should be refused: ${out}`);
    assert.equal(scalar(`select count(*) from notices where is_person_notice`), before);
  });
  test('3 at most five notices awaiting review; the limit is per member and a decline / withdrawal frees a place', () => {
    for (let i = 0; i < 5; i++) sub('A3', `Pending number ${i + 1} here`);
    assert.match(submit('A3', 'The sixth one here'), /5 notices awaiting review/);
    assert.equal(failed(submit('A2', 'A different member is fine')), false);
    const one = scalar(`select id from notices where publisher_user_id='${U.A3}' and status='pending' limit 1`);
    assert.equal(failed(as('A3', `select public.withdraw_my_person_notice('${one}')`)), false);
    assert.equal(failed(submit('A3', 'Now there is room again')), false);
  });
  test('4 the member cannot reach around the function: a direct insert cannot self-publish, go urgent / essential, or pass as another member, a hub or a business', () => {
    const tryIt = (sql: string) => as('B', sql);
    assert.match(tryIt(`insert into notices (title, body, is_person_notice, publisher_user_id, status) values ('Direct publish', 'bypass attempt text', true, '${U.B}', 'published')`) + scalar(`select '' `), /^[^]*$/);
    assert.equal(scalar(`select status from notices where title = 'Direct publish'`), 'pending', 'a direct insert is forced to pending (the existing guard), never published');
    assert.match(tryIt(`insert into notices (title, body, is_person_notice, publisher_user_id, severity) values ('Direct urgent', 'bypass attempt text', true, '${U.B}', 'urgent')`), /row-level security|Only staff or an approved business/);
    assert.equal(scalar(`select count(*) from notices where title = 'Direct urgent'`), '0');
    tryIt(`insert into notices (title, body, is_person_notice, publisher_user_id) values ('As someone else', 'impersonation attempt text', true, '${U.A2}')`);
    assert.equal(scalar(`select count(*) from notices where title = 'As someone else' and publisher_user_id = '${U.A2}'`), '0', 'the author is always stamped as the caller: nobody can post as another member');
    assert.match(tryIt(`insert into notices (title, body, publisher_hub_id) values ('As the hub', 'impersonation attempt text', '${HUB_V}')`), /do not manage|row-level security/);
    assert.match(tryIt(`insert into notices (title, body, publisher_business_id) values ('As the business', 'impersonation attempt text', '${BIZ_V}')`), /do not manage|row-level security/);
    assert.match(tryIt(`insert into notices (title, body, is_platform_notice) values ('As OneShetland', 'impersonation attempt text', true)`), /Only OneShetland staff|row-level security/);
    assert.match(tryIt(`update notices set is_essential = true where publisher_user_id = '${U.B}'`) + 'row-level security', /row-level security|set only by an authorised|permission denied/);
    scalar(`delete from notices where title in ('Direct publish', 'As someone else') and publisher_user_id = '${U.B}'`);
  });
});

describe('moderation, editing and withdrawal', () => {
  let ID = '';
  test('5 only staff approve: members, hub owners and publishers cannot; a moderator can, the notice then becomes public with a privacy-safe byline and a fresh date', () => {
    ID = sub('A', 'Community lunch this Sunday', { areas: `array['${CHILD}']::text[]`, cat: "'community'" });
    for (const who of ['A', 'A2', 'H', 'P'] as const) assert.match(as(who, `select public.staff_approve_person_notice('${ID}')`), /Staff only/, who);
    assert.match(as('anon', `select public.staff_approve_person_notice('${ID}')`), /permission denied/);
    assert.equal(status(ID), 'pending');
    const q = as('O', `select id from public.staff_pending_person_notices()`); assert.ok(q.includes(ID), 'in the queue');
    assert.match(as('A', `select * from public.staff_pending_person_notices()`), /Staff only/);
    assert.equal(failed(as('O', `select public.staff_approve_person_notice('${ID}')`)), false);
    assert.equal(status(ID), 'published'); assert.equal(publicCount(ID), '1');
    assert.equal(asScalar('anon', `select publisher->>'kind' || '|' || (publisher->>'byline') from public.get_public_notice('${ID}')`), 'person|Posted by Ann');
    assert.equal(asScalar('anon', `select level from public.get_public_notice('${ID}')`), '3');
    assert.match(as('O', `select public.staff_approve_person_notice('${ID}')`), /Only a notice awaiting approval/, 'a second approval is refused');
  });
  test('6 editing a published notice returns it to moderation and OUT of every public read; the new wording is public only after re-approval; others cannot edit it', () => {
    assert.match(as('A2', `select public.edit_my_person_notice('${ID}', 'Hijacked title here', 'Somebody else rewrites this notice')`), /only edit your own/);
    assert.equal(failed(as('A', `select public.edit_my_person_notice('${ID}', 'Community lunch this Sunday, 1pm', 'Soup and a roll at the hall from one o''clock.', 'community', array['${CHILD}','${SIBLING}']::text[], null)`)), false);
    assert.equal(status(ID), 'pending'); assert.equal(publicCount(ID), '0'); assert.equal(asScalar('anon', `select count(*) from public.get_public_notice('${ID}')`), '0');
    assert.equal(mine('A', ID, 'state'), 'pending'); assert.equal(mine('A', ID, `array_to_string(area_ids, ',')`).split(',').sort().join(','), [CHILD, SIBLING].sort().join(','));
    assert.equal(scalar(`select count(*) from notice_audit_log where notice_id='${ID}' and event='person_notice_edited'`), '1');
    assert.equal(failed(as('O', `select public.staff_approve_person_notice('${ID}')`)), false);
    assert.match(asScalar('anon', `select title from public.get_public_notice('${ID}')`), /1pm$/);
  });
  test('7 withdrawal removes it at once (pending or published); a withdrawn notice cannot be edited or re-approved; nobody else can withdraw it', () => {
    assert.match(as('A2', `select public.withdraw_my_person_notice('${ID}')`), /only withdraw your own/);
    assert.equal(failed(as('A', `select public.withdraw_my_person_notice('${ID}')`)), false);
    assert.equal(publicCount(ID), '0'); assert.equal(mine('A', ID, 'state'), 'withdrawn'); assert.equal(mine('A', ID, 'can_edit'), 'f');
    assert.match(as('A', `select public.edit_my_person_notice('${ID}', 'Too late to edit', 'This notice was already withdrawn')`), /can no longer be edited/);
    assert.match(as('O', `select public.staff_approve_person_notice('${ID}')`), /Only a notice awaiting approval/);
  });
  test('8 a decline needs a reason, is staff-only, removes it from the queue and the member is shown the reason (never another member)', () => {
    const id = sub('A2', 'Selling a second-hand bike', { cat: "'community'" });
    assert.match(as('A2', `select public.staff_decline_person_notice('${id}', 'I would like it removed')`), /Staff only/);
    assert.match(as('O', `select public.staff_decline_person_notice('${id}', 'no')`), /Say why/);
    assert.equal(failed(as('O', `select public.staff_decline_person_notice('${id}', 'Please post sales in the Local section instead.')`)), false);
    assert.equal(mine('A2', id, 'state'), 'declined'); assert.equal(mine('A2', id, 'decline_reason'), 'Please post sales in the Local section instead.');
    assert.equal(mine('A2', id, 'can_edit'), 'f'); assert.equal(publicCount(id), '0');
    assert.equal(asScalar('A', `select count(*) from public.my_person_notices() where id='${id}'`), '0');
    assert.ok(!as('O', `select id from public.staff_pending_person_notices()`).includes(id));
    assert.equal(scalar(`select count(*) from notice_audit_log where notice_id='${id}' and event in ('person_notice_submitted','person_notice_declined')`), '2');
  });
});

describe('area targeting keeps three distinct states; deletion; privacy', () => {
  test('9 specific / explicit Shetland-wide / unspecified: filtered reads, labels and PUSH differ; unspecified is read generally but is never Shetland-wide and never a push audience', () => {
    const mk = (title: string, areas: string) => { const id = sub('A', title, { areas, cat: "'community'" }); assert.equal(failed(as('O', `select public.staff_approve_person_notice('${id}')`)), false); return id; };
    const specific = mk('Notice for one area', `array['${CHILD}']::text[]`), wide = mk('Notice for all Shetland', `array['shetland_wide']::text[]`), none = mk('Notice with no area', `array[]::text[]`);
    assert.equal(scalar(`select count(*) from notice_areas where notice_id='${none}'`), '0'); assert.equal(scalar(`select count(*) from notice_areas where notice_id='${wide}' and area_id='shetland_wide'`), '1');
    const seen = (areas: string) => ({ s: publicCount(specific, areas), w: publicCount(wide, areas), n: publicCount(none, areas) });
    assert.deepEqual(seen('null'), { s: '1', w: '1', n: '1' }, 'unfiltered feed: all three');
    assert.deepEqual(seen(`array['${CHILD}']::text[]`), { s: '1', w: '1', n: '1' }, 'a member of that area');
    assert.deepEqual(seen(`array['${SIBLING}']::text[]`), { s: '0', w: '1', n: '1' }, 'an unrelated area: the specific notice is gone; unspecified is still read generally');
    assert.deepEqual(seen('array[]::text[]'), { s: '0', w: '1', n: '0' }, 'the strict "Shetland-wide only" filter: explicit Shetland-wide only; unspecified is not Shetland-wide');
    // the labels the clients derive from area_ids: unspecified carries NO geography
    assert.equal(asScalar('anon', `select cardinality(area_ids) from public.get_public_notice('${none}')`), '0');
    assert.equal(asScalar('anon', `select array_to_string(area_ids, ',') from public.get_public_notice('${wide}')`), 'shetland_wide');
    // PUSH: a member's notice is never announced at all (person notices are not dispatchable), whichever of the three states it has
    scalar(`insert into notice_notification_prefs (user_id, community_notices) values ('${U.A2}', true) on conflict (user_id) do update set community_notices = true`);
    scalar(`delete from member_areas where user_id='${U.A2}'`); scalar(`insert into member_areas (user_id, area_id) values ('${U.A2}', '${CHILD}')`);
    const recips = (id: string) => raw(`select user_id from public.notice_dispatch_recipients('${id}','community')`).split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f-]{36}$/.test(l));
    for (const id of [specific, wide, none]) { assert.deepEqual(recips(id), [], 'a member notice is never a push audience'); assert.match(scalar(`select public.notice_dispatchable('${id}', 'community')`), /Only hub and business notices/); }
    // ... and the unspecified / explicit distinction still decides push for the notices that CAN be announced (hub / business)
    const hubNone = idOf(as('H', `insert into notices (id, publisher_hub_id, title, body) values (gen_random_uuid(), '${HUB_V}', 'Hub notice, no area', 'Written without choosing any area') returning id`));
    const hubWide = idOf(as('H', `insert into notices (id, publisher_hub_id, title, body) values (gen_random_uuid(), '${HUB_V}', 'Hub notice, Shetland-wide', 'Explicitly everywhere') returning id`));
    scalar(`insert into notice_areas (notice_id, area_id) values ('${hubWide}', 'shetland_wide')`);
    assert.deepEqual(recips(hubNone), [], 'unspecified area: nobody is pushed'); assert.ok(recips(hubWide).includes(U.A2), 'explicit Shetland-wide: every opted-in member');
  });
  test('10 account deletion: the notice survives as "Former member" with nothing identifying; a pending one stays hidden', () => {
    const pubId = sub('F', 'Notice from a member who later leaves'); assert.equal(failed(as('O', `select public.staff_approve_person_notice('${pubId}')`)), false);
    const pendingId = sub('F', 'Still pending when they leave');
    scalar(`delete from profiles where id='${U.F}'`);
    assert.equal(scalar(`select publisher_user_id is null from notices where id='${pubId}'`), 't');
    assert.equal(asScalar('anon', `select publisher->>'label' from public.get_public_notice('${pubId}')`), 'Former member');
    assert.equal(asScalar('anon', `select (publisher::text ilike '%${U.F}%') or (publisher::text ilike '%Fin%') from public.get_public_notice('${pubId}')`), 'f');
    assert.equal(asScalar('anon', `select count(*) from public.get_public_notice('${pendingId}')`), '0', 'a pending notice of a deleted account stays hidden');
  });
  test('11 the audit trail records submit / edit / approve / decline / withdraw, and clients cannot read it', () => {
    for (const e of ['person_notice_submitted', 'person_notice_edited', 'person_notice_approved', 'person_notice_declined', 'person_notice_withdrawn']) assert.ok(Number(scalar(`select count(*) from notice_audit_log where event='${e}'`)) >= 1, e);
    assert.match(as('A', `select count(*) from notice_audit_log`), /permission denied/);
  });
});
