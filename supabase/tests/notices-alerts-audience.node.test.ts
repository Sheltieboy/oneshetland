/**
 * notices-alerts-audience.node.test.ts — Notices & Alerts step 3: member areas, opt-in preferences, server-side audience selection, deduplicated and
 * idempotent dispatch, and the silence of official imports — proven in an ISOLATED Postgres (migrations 20261129000000-20261129020000 on today's model).
 *
 * PROVES: choosing areas never turns on a notification and every audience is default-OFF; a member with no areas gets Shetland-wide notices only; area
 * matching covers the area, its parent and its children but never the Shetland-wide root as an ancestor; one member is selected ONCE however many affected
 * areas they follow; opt-in is per audience; only the database chooses recipients (clients cannot call the dispatch machinery); a notice that is withdrawn,
 * resolved, hidden, expired, scheduled or imported is not dispatchable (and a withdrawal mid-run empties the audience); a completed dispatch can never
 * repeat, whatever is edited afterwards, while a failed or stale one can be resumed without re-sending; imports are refused by four independent layers;
 * dispatch authority follows the real publisher relationships; and deleting an account removes its areas, preferences and delivery rows.
 * SAFETY — ISOLATED DATABASE ONLY; nothing is sent (this layer only selects and records).
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildDatabase, U, as, asScalar, raw, file, scalar, failed, idOf, areaIds, HUB_V, HUB_O, BIZ_B, BIZ_V, N_LEGACY, uuid } from './_support/notices-alerts-harness.ts';

let COUNCIL = '', NHS = '', AREAS: string[] = [], CHILD = '', PARENT = '', OTHER = '';
const BODY = 'The A970 is closed at the Voe junction following a landslip. Use the Delting route.';
const ACT = 'Use the Delting route and allow extra time.';
const U1 = uuid(), U2 = uuid(), U3 = uuid(), U4 = uuid(), U5 = uuid(), U6 = uuid();

const publish = (who: Parameters<typeof as>[0], o: Partial<{ title: string; areas: string[]; ess: boolean; cat: string; pub: string }> = {}) => {
  const a = { title: 'Road closed at Voe junction', areas: ['shetland_wide'], ess: true, cat: 'travel_transport', pub: COUNCIL, ...o };
  const out = as(who, `select public.official_publish_notice(p_publisher => '${a.pub}', p_title => '${a.title}', p_body => '${BODY}', p_category => '${a.cat}',
    p_area_ids => array[${a.areas.map((x) => `'${x}'`).join(',')}]::text[], p_expires_at => now() + interval '2 days', p_action_text => '${ACT}', p_is_essential => ${a.ess},
    p_review_at => ${a.ess ? "now() + interval '1 day'" : 'null'})`);
  assert.ok(!failed(out), out); return idOf(out);
};
const recips = (notice: string, kind: string) => raw(`select user_id from public.notice_dispatch_recipients('${notice}','${kind}')`).split('\n').filter((l) => /^[0-9a-f-]{36}$/.test(l.trim())).map((l) => l.trim()).sort();
const svc = (sql: string) => as('service', sql);
const prefs = (u: string, f: string) => file(`insert into notice_notification_prefs (user_id, ${f.split('=')[0]}) values ('${u}', ${f.split('=')[1]}) on conflict (user_id) do update set ${f}`);

before(() => {
  buildDatabase(3);
  AREAS = areaIds();
  const kid = raw(`select a.id || ',' || a.parent_id from areas a join areas p on p.id = a.parent_id where p.type = 'locality' and a.is_active limit 1`).split(',');
  CHILD = kid[0]; PARENT = kid[1]; OTHER = AREAS.find((a) => a !== PARENT)!;
  COUNCIL = idOf(as('S', `select public.admin_upsert_official_publisher('shetland-islands-council','Shetland Islands Council','council')`));
  NHS = idOf(as('S', `select public.admin_upsert_official_publisher('nhs-shetland','NHS Shetland','health')`));
  for (const o of [COUNCIL, NHS]) as('S', `select public.admin_verify_official_publisher('${o}','Verified by call-back to the published number')`);
  as('S', `select public.admin_set_official_publisher_member('${COUNCIL}','${U.P}','publisher')`);
  as('S', `select public.admin_set_official_publisher_member('${COUNCIL}','${U.D}','delegate')`);
  as('S', `select public.admin_set_official_publisher_member('${NHS}','${U.N}','publisher')`);
  as('S', `select public.admin_grant_essential_alert('${COUNCIL}','Approved first Essential Alert publisher')`);
  // the cast of recipients: real profile rows so the foreign keys hold
  for (const [i, u] of [U1, U2, U3, U4, U5, U6].entries()) file(`insert into profiles (id, role, display_name) values ('${u}','customer','Member ${i + 1}')`);
});

describe('areas and consent are separate', () => {
  test('1 preferences start OFF for every audience; choosing areas changes no preference; nothing is subscribed by browsing', () => {
    assert.deepEqual(JSON.parse(asScalar('A', `select public.my_notice_prefs()::text`)), { essential_alerts: false, official_notices: false, community_notices: false, community_categories: null, funeral_notices: false });
    assert.equal(asScalar('A', `select cardinality(public.set_my_notice_areas(array['${AREAS[0]}','${AREAS[1]}']))`), '2');
    assert.equal(asScalar('A', `select public.my_notice_prefs()->>'essential_alerts'`), 'false');
    assert.equal(scalar(`select count(*) from notice_notification_prefs where user_id='${U.A}'`), '0', 'selecting areas creates no preference row at all');
    assert.match(as('anon', `select count(*) from public.member_areas`), /permission denied/, 'anonymous browsing reads and subscribes nothing');
  });
  test('2 area validation: sign-in required, real active physical areas only (not Shetland-wide), at most 12, replace semantics', () => {
    assert.match(as('anon', `select public.set_my_notice_areas(array['${AREAS[0]}'])`), /permission denied|Sign in/);
    assert.match(as('A', `select public.set_my_notice_areas(array['shetland_wide'])`), /real Shetland areas/);
    assert.match(as('A', `select public.set_my_notice_areas(array['atlantis'])`), /real Shetland areas/);
    const many = raw(`select string_agg(quote_literal(id), ',') from (select id from areas where is_physical and is_active limit 13) s`);
    assert.match(as('A', `select public.set_my_notice_areas(array[${many}])`), /at most 12/);
    assert.equal(asScalar('A', `select public.set_my_notice_areas(array['${AREAS[2]}','${AREAS[2]}'])::text`), `{${AREAS[2]}}`, 'duplicates collapse');
    assert.equal(asScalar('A', `select public.my_notice_areas()::text`), `{${AREAS[2]}}`, 'previous selection replaced');
    assert.equal(asScalar('A', `select cardinality(public.set_my_notice_areas(array[]::text[]))`), '0');
  });
  test('3 preferences: partial updates, category validation, clearing the category filter; each member reads only their own rows', () => {
    assert.match(as('A', `select public.set_my_notice_prefs(p_categories => array['made_up'])`), /Unknown notice category/);
    assert.equal(asScalar('A', `select public.set_my_notice_prefs(p_essential => true)->>'essential_alerts'`), 'true');
    assert.equal(asScalar('A', `select public.my_notice_prefs()->>'official_notices'`), 'false', 'an untouched audience stays off');
    assert.equal(asScalar('A', `select public.set_my_notice_prefs(p_community => true, p_categories => array['lost_found'])->'community_categories'::text`), '["lost_found"]');
    assert.equal(asScalar('A', `select coalesce(public.set_my_notice_prefs(p_all_community_categories => true)->>'community_categories','NONE')`), 'NONE');
    assert.equal(asScalar('A2', `select count(*) from notice_notification_prefs`), '0', 'another member sees none of A\'s rows');
    assert.equal(asScalar('A2', `select count(*) from member_areas`), '0');
    assert.match(as('A', `update notice_notification_prefs set essential_alerts = false`), /permission denied/, 'no direct writes');
    assert.match(as('A', `insert into member_areas (user_id, area_id) values ('${U.A}','${AREAS[0]}')`), /permission denied/);
  });
});

describe('what may be announced, and who may ask', () => {
  let ESS = '', ORD = '', HUBN = '', IMP = '', PERSON = '';
  before(() => {
    ESS = publish('P');
    ORD = publish('P', { ess: false, title: 'Bin collection changes over the holiday period', cat: 'public_services' });
    HUBN = idOf(as('H', `insert into notices (id, publisher_hub_id, title, body) values (gen_random_uuid(), '${HUB_V}', 'Hall closed Saturday', 'The hall is closed for cleaning.') returning id`));
    IMP = idOf(file(`insert into notices (is_platform_notice, source, source_reference, source_label, source_url, expires_at, title, body, severity, official_publisher_id)
      values (true,'sic_council','imp-1','Shetland Islands Council (Official Notices)','https://www.shetland.gov.uk/n/1', now()+interval '3 days','Imported council notice','Summary of an imported notice.','info', null) returning id`));
    PERSON = idOf(file(`insert into notices (is_person_notice, publisher_user_id, severity, title, body, status) values (true,'${U.A}','info','Lost a cat','Answers to Biscuit.','published') returning id`));
  });
  test('4 dispatchable: an active essential alert only for "essential"; ordinary official only for "official"; hub notices for hub/community; never persons, platform, imports', () => {
    const d = (n: string, k: string) => scalar(`select coalesce(public.notice_dispatchable('${n}','${k}'),'OK')`);
    assert.equal(d(ESS, 'essential'), 'OK');
    assert.match(d(ESS, 'official'), /ordinary official notice/);
    assert.equal(d(ORD, 'official'), 'OK');
    assert.match(d(ORD, 'essential'), /not an active Essential Alert/);
    assert.equal(d(HUBN, 'hub'), 'OK'); assert.equal(d(HUBN, 'community'), 'OK');
    assert.match(d(HUBN, 'essential'), /not an active Essential Alert/);
    assert.match(d(PERSON, 'community'), /Only hub and business notices/);
    assert.match(d(N_LEGACY, 'community'), /OK|Only hub/);   // the legacy hub notice IS a hub notice
    assert.match(d(ESS, 'bogus'), /Unknown audience/);
    assert.match(d(uuid(), 'hub'), /does not exist/);
  });
  test('5 OFFICIAL IMPORTS ARE SILENT through every route: not dispatchable, not claimable, no recipients, and no delivery row can be written', () => {
    for (const k of ['essential', 'official', 'community', 'hub']) {
      assert.match(scalar(`select public.notice_dispatchable('${IMP}','${k}')`), /never announced/, k);
      assert.match(svc(`select public.notice_claim_dispatch('${IMP}','${k}')`), /never announced/, k);
      assert.deepEqual(recips(IMP, k), [], k);
    }
    assert.match(file(`insert into notice_deliveries (subject_type, subject_id, user_id, kind) values ('notice','${IMP}','${U1}','official')`), /never announced/, 'the trigger is the last layer');
    assert.match(svc(`select public.notice_record_delivery('${IMP}','${U1}','official','sent')`), /never announced/);
    assert.equal(scalar(`select count(*) from notice_deliveries where subject_id='${IMP}'`), '0');
  });
  test('6 non-live states are not dispatchable: pending, withdrawn, resolved, hidden, scheduled, expired, and a revoked essential alert', () => {
    const states: [string, string][] = [
      ['withdrawn', `status='withdrawn'`], ['resolved', `status='resolved'`], ['hidden', `is_hidden=true`], ['scheduled', `starts_at = now() + interval '1 hour'`],
      ['expired', `expires_at = now() - interval '1 minute', review_at = now() - interval '2 minutes'`], ['past review', `review_at = now() - interval '1 minute'`],
    ];
    for (const [label, set] of states) {
      const id = publish('P', { title: `Probe ${label} alert` });
      assert.equal(scalar(`select coalesce(public.notice_dispatchable('${id}','essential'),'OK')`), 'OK', `${label} before`);
      raw(`update notices set ${set} where id='${id}'`);
      assert.notEqual(scalar(`select coalesce(public.notice_dispatchable('${id}','essential'),'OK')`), 'OK', label);
      assert.match(svc(`select public.notice_claim_dispatch('${id}','essential')`), /not|expired|hidden|started/, label);
    }
    const pend = idOf(file(`insert into notices (publisher_hub_id, title, body, status) values ('${HUB_V}','Pending hub notice','b','pending') returning id`));
    assert.match(scalar(`select public.notice_dispatchable('${pend}','hub')`), /not published/);
  });
  test('6b R2: notify-hub-content may announce ONLY a live hub notice — pending, withdrawn, resolved, hidden, scheduled, expired, committee-only, imported, platform, person, a deleted id and a made-up id are all refused; the legitimate hub notice passes', () => {
    const base = (cols: string, vals: string) => idOf(file(`insert into notices (publisher_hub_id, title, body, ${cols}) values ('${HUB_V}', 'R2 probe', 'body', ${vals}) returning id`));
    const reason = (id: string) => scalar(`select coalesce(public.notice_dispatchable('${id}','hub'),'OK')`);
    const live = base('visibility', `'public'`);
    assert.equal(reason(live), 'OK', 'a legitimate hub notice');
    assert.equal(reason(base('visibility', `'members'`)), 'OK', 'a members-only hub notice may be announced to the members');
    const refused: [string, string][] = [
      ['pending', base('status', `'pending'`)], ['withdrawn', base('status', `'withdrawn'`)], ['resolved', base('status', `'resolved'`)], ['hidden', base('is_hidden', 'true')],
      ['scheduled', base('starts_at', `now() + interval '1 hour'`)], ['expired', base('expires_at', `now() - interval '1 minute'`)], ['committee-only', base('visibility', `'committee'`)],
    ];
    for (const [label, id] of refused) assert.notEqual(reason(id), 'OK', label);
    assert.match(reason(IMP), /never announced/, 'imported');
    assert.match(reason(PERSON), /not a hub notice/, 'person');
    assert.match(reason(ESS), /not a hub notice/, 'platform / organisation');
    assert.match(reason(uuid()), /does not exist/, 'made-up id');
    // withdrawn after the fact, and an edit after announcing: the once-only claim holds
    const d = idOf(svc(`select public.notice_claim_dispatch('${live}','hub')`)); svc(`select public.notice_complete_dispatch('${d}')`);
    file(`update notices set title = 'R2 probe, edited' where id='${live}'`);
    assert.match(svc(`select public.notice_claim_dispatch('${live}','hub')`), /Already announced/);
  });
  test('7 who may dispatch follows the real relationships (publisher member with the entitlement; delegate for official only; hub owner for own hub; administrator any)', () => {
    const can = (u: keyof typeof U, n: string, k: string) => scalar(`select public.can_dispatch_notice('${U[u]}','${n}','${k}')`);
    assert.equal(can('P', ESS, 'essential'), 't'); assert.equal(can('D', ESS, 'essential'), 'f', 'a delegate cannot announce an essential alert');
    assert.equal(can('D', ORD, 'official'), 't'); assert.equal(can('P', ORD, 'official'), 't');
    assert.equal(can('N', ESS, 'essential'), 'f', 'another organisation cannot'); assert.equal(can('N', ORD, 'official'), 'f');
    assert.equal(can('A', ESS, 'essential'), 'f'); assert.equal(can('O', ESS, 'essential'), 'f', 'a moderator is not a platform administrator');
    assert.equal(can('S', ESS, 'essential'), 't'); assert.equal(can('S', ORD, 'official'), 't');
    assert.equal(can('H', HUBN, 'hub'), 't'); assert.equal(can('H', HUBN, 'community'), 't');
    assert.equal(can('C', HUBN, 'hub'), 't', 'committee of the hub');
    assert.equal(can('M', HUBN, 'hub'), 'f', 'an ordinary member cannot'); assert.equal(can('B', HUBN, 'hub'), 'f'); assert.equal(can('A', HUBN, 'community'), 'f');
    assert.equal(can('P', HUBN, 'hub'), 'f');
    assert.equal(scalar(`select public.can_dispatch_notice(null,'${ESS}','essential')`), 'f');
    // a revoked entitlement removes the right to announce essential alerts at once
    const n2 = publish('P', { title: 'Revocation probe alert' });
    as('S', `select public.admin_revoke_essential_alert('${COUNCIL}','probe')`);
    assert.equal(can('P', n2, 'essential'), 'f');
    as('S', `select public.admin_grant_essential_alert('${COUNCIL}','probe re-grant')`);
  });
  test('8 no client can call the dispatch machinery or read its records: recipients are chosen by the database alone', () => {
    for (const who of ['A', 'S', 'P', 'H', 'anon'] as const) {
      for (const fn of [`notice_dispatch_recipients('${ESS}','essential')`, `notice_claim_dispatch('${ESS}','essential')`, `notice_dispatchable('${ESS}','essential')`,
                        `can_dispatch_notice('${U.A}','${ESS}','essential')`, `notice_record_delivery('${ESS}','${U1}','essential','sent')`]) {
        assert.match(as(who, `select * from public.${fn}`), /permission denied/, `${who} ${fn}`);
      }
      assert.match(as(who, `select count(*) from notice_deliveries`), /permission denied/);
      assert.match(as(who, `select count(*) from notice_dispatches`), /permission denied/);
    }
    assert.match(as('A', `select * from public.admin_notice_dispatch_history('${ESS}')`), /Platform administrators only/);
  });
});

describe('who is in the audience (server-selected, once each)', () => {
  const setAreas = (u: string, areas: string[]) => file(`delete from member_areas where user_id='${u}'; insert into member_areas (user_id, area_id) values ${areas.map((a) => `('${u}','${a}')`).join(',') || "('00000000-0000-0000-0000-000000000000','x')"}`);
  before(() => {
    // U1: essential on, follows [AREAS0, AREAS1] | U2: essential on, NO areas | U3: essential OFF, follows AREAS0 | U4: essential on, follows the CHILD
    // U5: essential on, follows OTHER | U6: no preference row at all, follows AREAS0
    file(`delete from notice_notification_prefs; delete from member_areas where true`);
    for (const u of [U1, U2, U4, U5]) file(`insert into notice_notification_prefs (user_id, essential_alerts) values ('${u}', true)`);
    file(`insert into notice_notification_prefs (user_id, essential_alerts) values ('${U3}', false)`);
    file(`insert into member_areas (user_id, area_id) values ('${U1}','${PARENT}'), ('${U1}','${OTHER}'), ('${U3}','${PARENT}'), ('${U4}','${CHILD}'), ('${U5}','${OTHER}'), ('${U6}','${PARENT}')`);
    file(`delete from member_areas where user_id='${U5}'; insert into member_areas (user_id, area_id) select '${U5}', id from areas where is_physical and is_active and id not in ('${PARENT}','${CHILD}','${OTHER}') and parent_id is distinct from '${PARENT}' and id <> coalesce((select parent_id from areas where id='${OTHER}'),'') limit 1`);
  });
  test('9 a Shetland-wide essential alert reaches every opted-in member (including one with no areas), not the opted-out or never-opted-in', () => {
    const id = publish('P', { title: 'Wide alert for everyone' });
    assert.deepEqual(recips(id, 'essential'), [U1, U2, U4, U5].sort());
  });
  test('10 an area-specific alert reaches only opted-in members following that area, its parent or its children; a member with no areas is NOT treated as following everything', () => {
    const id = publish('P', { title: 'Locality alert for one place', areas: [PARENT] });
    const got = recips(id, 'essential');
    assert.ok(got.includes(U1) && got.includes(U4), 'the locality follower (U1) and a follower of a settlement inside it (U4)');
    assert.ok(!got.includes(U2), 'no selected areas: not in an area-specific audience');
    assert.ok(!got.includes(U3), 'opted out');
    assert.ok(!got.includes(U6), 'never opted in (areas alone subscribe nobody)');
    assert.ok(!got.includes(U5), 'follows an unrelated area');
    const kid = publish('P', { title: 'Settlement alert for one village', areas: [CHILD] });
    assert.ok(recips(kid, 'essential').includes(U1), 'a follower of the containing locality is relevant too');
  });
  test('11 a member following SEVERAL affected areas is selected exactly once', () => {
    const id = publish('P', { title: 'Alert across two localities', areas: [PARENT, OTHER] });
    const got = raw(`select user_id from public.notice_dispatch_recipients('${id}','essential')`).split('\n').filter((l) => /^[0-9a-f-]{36}$/.test(l.trim()));
    assert.equal(got.filter((x) => x.trim() === U1).length, 1);
    assert.equal(new Set(got).size, got.length, 'no duplicates at all');
  });
  test('12 duplicate devices and duplicate subscriptions cannot multiply a recipient (the audience is users, keyed once per notice)', () => {
    file(`insert into push_tokens (user_id, token) values ('${U1}','tok-a'), ('${U1}','tok-b'), ('${U1}','tok-c')`);
    const id = publish('P', { title: 'Alert for a many-device member' });
    assert.equal(recips(id, 'essential').filter((x) => x === U1).length, 1);
    assert.match(file(`insert into notice_deliveries (subject_type, subject_id, user_id, kind) values ('notice','${id}','${U1}','essential'),('notice','${id}','${U1}','essential')`), /duplicate key|more than once/);
  });
  test('13 each audience is its own opt-in: essential opt-in does not receive official notices; community honours the category filter', () => {
    const ord = publish('P', { ess: false, title: 'Routine council service announcement', cat: 'public_services' });
    assert.deepEqual(recips(ord, 'official'), [], 'nobody opted in to official notices');
    file(`update notice_notification_prefs set official_notices = true where user_id = '${U2}'`);
    assert.deepEqual(recips(ord, 'official'), [U2]);
    const hubn = idOf(as('H', `insert into notices (id, publisher_hub_id, title, body, category) values (gen_random_uuid(), '${HUB_V}', 'Hall notice', 'Body', 'community') returning id`));
    file(`insert into notice_notification_prefs (user_id, community_notices, community_categories) values ('${U6}', true, array['lost_found']) on conflict (user_id) do update set community_notices = true, community_categories = array['lost_found']`);
    file(`insert into member_areas (user_id, area_id) values ('${U6}','${PARENT}') on conflict do nothing`);
    file(`insert into notice_areas (notice_id, area_id) values ('${hubn}', 'shetland_wide')`);
    assert.deepEqual(recips(hubn, 'community'), [], 'U6 only wants lost & found, this is a community notice');
    file(`update notice_notification_prefs set community_categories = null where user_id = '${U6}'`);
    assert.deepEqual(recips(hubn, 'community'), [U6], 'no category filter = every community category');
  });
  test('13b OPT-IN POLICY MATRIX: a member with NO preference row, or a row with everything off, or only areas chosen, is in NO audience; each flag opens exactly its own audience and nothing else', () => {
    file(`drop table if exists _prefs_bak; create table _prefs_bak as select * from notice_notification_prefs; delete from notice_notification_prefs`);
    try {
      // U1: no preference row | U2: a row, everything off | U3: essential only | U4: official only | U5: community only. All follow a place and have a device.
      file(`insert into notice_notification_prefs (user_id) values ('${U2}')`);
      file(`insert into notice_notification_prefs (user_id, essential_alerts) values ('${U3}', true)`);
      file(`insert into notice_notification_prefs (user_id, official_notices) values ('${U4}', true)`);
      file(`insert into notice_notification_prefs (user_id, community_notices) values ('${U5}', true)`);
      file(`delete from member_areas where user_id in ('${U1}','${U2}','${U3}','${U4}','${U5}'); insert into member_areas (user_id, area_id) select u, '${PARENT}' from unnest(array['${U1}','${U2}','${U3}','${U4}','${U5}']::uuid[]) u`);
      const ess = publish('P', { title: 'Matrix essential alert' }), ord = publish('P', { ess: false, title: 'Matrix routine official notice', cat: 'public_services' });
      const hubn = idOf(as('H', `insert into notices (id, publisher_hub_id, title, body, category) values (gen_random_uuid(), '${HUB_V}', 'Matrix hall notice', 'Body', 'community') returning id`));
      file(`insert into notice_areas (notice_id, area_id) values ('${hubn}', 'shetland_wide')`);
      assert.deepEqual(recips(ess, 'essential'), [U3], 'essential alerts: only the member who chose them');
      assert.deepEqual(recips(ord, 'official'), [U4], 'official notices: only the member who chose them');
      assert.deepEqual(recips(hubn, 'community'), [U5], 'community notices: only the member who chose them');
      for (const [id, kind] of [[ess, 'essential'], [ord, 'official'], [hubn, 'community']] as const) for (const none of [U1, U2]) assert.ok(!recips(id, kind).includes(none), `${none} (no row / all off) must not qualify for ${kind}`);
    } finally { file(`delete from notice_notification_prefs; insert into notice_notification_prefs select * from _prefs_bak; drop table _prefs_bak`); }
  });
  test('14 hub notices go to that hub\'s ACTIVE members only (not other hubs, not lapsed or removed members)', () => {
    const hubn = idOf(as('H', `insert into notices (id, publisher_hub_id, title, body) values (gen_random_uuid(), '${HUB_V}', 'Hub only news', 'Body') returning id`));
    file(`insert into hub_members (hub_id, user_id, role, status, paid_until) values ('${HUB_V}','${U1}','member','active', null), ('${HUB_V}','${U2}','member','active', now() - interval '1 day'),
      ('${HUB_V}','${U3}','member','removed', null), ('${HUB_O}','${U4}','member','active', null) on conflict do nothing`);
    const got = recips(hubn, 'hub');
    assert.ok(got.includes(U1) && got.includes(U.C) === got.includes(U.C));
    assert.ok(!got.includes(U2) && !got.includes(U3) && !got.includes(U4));
  });
});

describe('an organisation\'s own list', () => {
  test('24c my_official_notices: members of the organisation (and administrators) see ALL its notices in every state, including scheduled and resolved; nobody else, and nobody for another organisation', () => {
    const sched = (() => { const o = as('P', `select public.official_publish_notice(p_publisher => '${COUNCIL}', p_title => 'Own list scheduled', p_body => '${BODY}', p_category => 'travel_transport', p_area_ids => array['shetland_wide'], p_expires_at => now() + interval '2 days', p_starts_at => now() + interval '2 hours', p_action_text => '${ACT}', p_is_essential => true, p_review_at => now() + interval '1 day')`); assert.ok(!failed(o), o); return idOf(o); })();
    const done = publish('P', { title: 'Own list resolved' }); as('P', `select public.official_set_notice_status('${done}','resolved')`);
    for (const who of ['P', 'D', 'S'] as const) {
      const ids = as(who, `select id from public.my_official_notices('${COUNCIL}')`);
      assert.ok(ids.includes(sched) && ids.includes(done), `${who} sees scheduled and resolved`);
    }
    assert.equal(asScalar('P', `select announced::text from public.my_official_notices('${COUNCIL}') where id='${done}'`), 'false');
    for (const who of ['A', 'H', 'O', 'N', 'anon'] as const) assert.match(as(who, `select * from public.my_official_notices('${COUNCIL}')`), /not authorised|permission denied/, who);
    assert.match(as('P', `select * from public.my_official_notices('${NHS}')`), /not authorised/, 'not another organisation\'s');
  });
});

describe('idempotent, resumable dispatch', () => {
  test('15 one dispatch per notice per audience: claim, in-progress refused, complete, then NEVER again — whatever is edited afterwards', () => {
    const id = publish('P', { title: 'One-shot alert for dispatch test' });
    const claim = svc(`select public.notice_claim_dispatch('${id}','essential','${U.P}')`);
    assert.ok(!failed(claim), claim); const dispatch = idOf(claim);
    assert.match(svc(`select public.notice_claim_dispatch('${id}','essential')`), /already in progress/);
    svc(`select public.notice_record_delivery('${id}','${U2}','essential','sent')`);
    svc(`select public.notice_record_delivery('${id}','${U4}','essential','held_quiet')`);
    assert.ok(!failed(svc(`select public.notice_complete_dispatch('${dispatch}')`)));
    assert.equal(scalar(`select sent::text || held::text || status from notice_dispatches where id='${dispatch}'`), '11completed');
    assert.match(svc(`select public.notice_claim_dispatch('${id}','essential')`), /Already announced/);
    assert.ok(!failed(as('P', `select public.official_update_notice(p_notice => '${id}', p_title => 'Road reopened with one lane open')`)), 'editing is allowed');
    assert.match(svc(`select public.notice_claim_dispatch('${id}','essential')`), /Already announced/, 'but never triggers another announcement');
    as('P', `select public.official_set_notice_status('${id}','resolved')`);
    assert.match(svc(`select public.notice_claim_dispatch('${id}','essential')`), /not published|Already announced|not an active/, 'resolving does not announce either');
    assert.equal(scalar(`select count(*) from notice_dispatches where subject_id='${id}'`), '1');
  });
  test('16 a delivered / held / skipped member is never selected again; a failed one is retried at most 3 times; "sent" cannot be downgraded', () => {
    const id = publish('P', { title: 'Retry semantics alert' });
    svc(`select public.notice_record_delivery('${id}','${U2}','essential','sent')`);
    svc(`select public.notice_record_delivery('${id}','${U4}','essential','failed','provider timeout')`);
    const r1 = recips(id, 'essential'); assert.ok(!r1.includes(U2)); assert.ok(r1.includes(U4), 'a failed delivery is retried');
    svc(`select public.notice_record_delivery('${id}','${U4}','essential','failed','again')`);
    svc(`select public.notice_record_delivery('${id}','${U4}','essential','failed','and again')`);
    assert.ok(!recips(id, 'essential').includes(U4), 'after 3 failed attempts it stops being retried');
    svc(`select public.notice_record_delivery('${id}','${U2}','essential','failed','late error')`);
    assert.equal(scalar(`select status from notice_deliveries where subject_id='${id}' and user_id='${U2}'`), 'sent', 'a sent row is final');
    assert.equal(scalar(`select attempts from notice_deliveries where subject_id='${id}' and user_id='${U4}'`), '3');
  });
  test('17 a failed or stale dispatch can be resumed on the SAME row (no second dispatch, no repeats to those already served)', () => {
    const id = publish('P', { title: 'Resume semantics alert' });
    const d = idOf(svc(`select public.notice_claim_dispatch('${id}','essential')`));
    svc(`select public.notice_record_delivery('${id}','${U1}','essential','sent')`);
    svc(`select public.notice_fail_dispatch('${d}','edge function crashed')`);
    assert.equal(scalar(`select status from notice_dispatches where id='${d}'`), 'failed');
    const again = svc(`select public.notice_claim_dispatch('${id}','essential')`);
    assert.equal(idOf(again), d, 'same dispatch row');
    assert.ok(!recips(id, 'essential').includes(U1));
    raw(`update notice_dispatches set status='claimed', claimed_at = now() - interval '11 minutes' where id='${d}'`);
    assert.equal(idOf(svc(`select public.notice_claim_dispatch('${id}','essential')`)), d, 'a stale in-progress claim is resumable');
  });
  test('18 withdrawn BEFORE dispatch cannot be claimed; withdrawn DURING a run yields an empty audience on the next batch', () => {
    const a = publish('P', { title: 'Withdrawn before dispatch' });
    as('P', `select public.official_set_notice_status('${a}','withdrawn')`);
    assert.match(svc(`select public.notice_claim_dispatch('${a}','essential')`), /not published|not an active/);
    const b = publish('P', { title: 'Withdrawn mid-run alert' });
    const d = idOf(svc(`select public.notice_claim_dispatch('${b}','essential')`));
    assert.ok(recips(b, 'essential').length > 0);
    as('P', `select public.official_set_notice_status('${b}','withdrawn')`);
    assert.deepEqual(recips(b, 'essential'), []);
    assert.ok(d);
  });
  test('19 the audit trail records claims and completions; an administrator can read a notice\'s dispatch history', () => {
    assert.ok(Number(scalar(`select count(*) from notice_audit_log where event='dispatch_claimed'`)) >= 3);
    assert.ok(Number(scalar(`select count(*) from notice_audit_log where event='dispatch_completed'`)) >= 1);
    const id = scalar(`select subject_id from notice_dispatches where status='completed' limit 1`);
    assert.ok(Number(asScalar('S', `select count(*) from public.admin_notice_dispatch_history('${id}')`)) >= 1);
  });
  test('20 deleting an account removes its areas, preferences and delivery rows (and nothing else dispatch-related breaks)', () => {
    file(`insert into member_areas (user_id, area_id) values ('${U4}','${PARENT}') on conflict do nothing`);
    file(`delete from hub_members where user_id='${U4}'`);
    const del = file(`delete from profiles where id='${U4}'`); assert.ok(!failed(del), del);
    for (const t of ['member_areas', 'notice_notification_prefs', 'notice_deliveries']) assert.equal(scalar(`select count(*) from ${t} where user_id='${U4}'`), '0', t);
    assert.ok(Number(scalar(`select count(*) from notice_dispatches`)) >= 1);
  });
});

describe('account deletion support: delete_member_notice_data (the delete-account function soft-deletes, so the cascades never fire)', () => {
  test('a member\'s areas, preferences and delivery history are removed - theirs only, and only by the service role', () => {
    const fill = (who: 'A' | 'A2') => { assert.ok(!failed(as(who, `select public.set_my_notice_areas(array['${areaIds()[0]}'])`))); assert.ok(!failed(as(who, `select public.set_my_notice_prefs(p_essential => true, p_community => true)`))); scalar(`insert into notice_deliveries (subject_type, subject_id, user_id, kind, status) values ('notice', gen_random_uuid(), '${U[who]}', 'essential', 'sent')`); };
    fill('A'); fill('A2');
    for (const who of ['A', 'A2', 'anon'] as const) assert.match(as(who, `select public.delete_member_notice_data('${U.A}')`), /permission denied/, `${who} cannot call it, even about themselves`);
    assert.match(as('service', `select public.delete_member_notice_data(null)`), /member id is required/);
    const out = as('service', `select public.delete_member_notice_data('${U.A}')`); assert.match(out, /"member_areas": 1/); assert.match(out, /"notice_notification_prefs": 1/); assert.match(out, /"notice_deliveries": 1/);
    for (const t of ['member_areas', 'notice_notification_prefs', 'notice_deliveries']) { assert.equal(scalar(`select count(*) from ${t} where user_id='${U.A}'`), '0', t); assert.equal(scalar(`select count(*) from ${t} where user_id='${U.A2}'`), '1', `${t}: another member is untouched`); }
    assert.equal(as('service', `select public.delete_member_notice_data('${U.A}')`).includes('ERROR'), false, 'repeating it is harmless');
    assert.match(as('service', `select count(*) from member_areas`), /permission denied/, 'and the tables stay closed to direct service-role access');
  });
});
