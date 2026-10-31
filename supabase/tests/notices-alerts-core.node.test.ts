/**
 * notices-alerts-core.node.test.ts — Notices & Alerts steps 1-2 (publishers, entitlement, the essential designation, official publishing, public reads),
 * proven in an ISOLATED Postgres built from today's production notices model plus the two new migrations.
 *
 * PROVES: only a platform administrator controls organisations, members and the Essential Alert entitlement (a moderator, a hub owner, a business with
 * can_publish_urgent and a Council publisher cannot); an organisation must be verified and active; the entitlement is explicit, one-active-per-organisation,
 * revocable and audited; a delegate cannot designate essential; an organisation without the entitlement cannot; no client can write an essential or
 * organisation field directly, by any route; every essential rule is enforced on the server (areas, expiry, review time, action, https link); only an ACTIVE
 * essential alert is ever returned as one (expired / resolved / withdrawn / hidden / scheduled / past review / revoked are not); revocation demotes rather
 * than deletes; correction and resolution are scoped to the issuing organisation; the legacy notice and the old urgent permission are untouched; and the
 * audit trail is append-only. SAFETY — ISOLATED DATABASE ONLY (see the harness).
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildDatabase, U, as, asScalar, raw, file, scalar, failed, last, idOf, areaIds, HUB_V, BIZ_V, N_LEGACY } from './_support/notices-alerts-harness.ts';

let LEGACY_BEFORE = '';
const ORIG = "id, publisher_business_id, publisher_user_id, severity, title, body, is_pinned, is_hidden, expires_at, published_at, created_at, publisher_hub_id, visibility, is_platform_notice";
let COUNCIL = '', NHS = '', AREAS: string[] = [], CHILD = '', CHILD_PARENT = '';
const REFUSED = /set only by an authorised|row-level security|Only OneShetland staff|exactly one business or hub|permission denied/;
const BODY = 'The A970 is closed at the Voe junction following a landslip. Use the Delting route.';
const ACT = 'Use the Delting route and allow extra time.';

/** call official_publish_notice as `who`; returns the new id or the error text */
const publish = (who: Parameters<typeof as>[0], o: Partial<{ pub: string; title: string; body: string; cat: string; areas: string[]; exp: string; start: string; link: string; act: string; ess: boolean; review: string }> = {}) => {
  const a = { pub: COUNCIL, title: 'Road closed at Voe junction', body: BODY, cat: 'travel_transport', areas: ['shetland_wide'], exp: "now() + interval '2 days'", start: 'null', link: 'null', act: `'${ACT}'`, ess: false, review: "now() + interval '1 day'", ...o };
  const areas = `array[${a.areas.map((x) => `'${x}'`).join(',')}]::text[]`;
  const out = as(who, `select public.official_publish_notice(p_publisher => '${a.pub}', p_title => '${a.title}', p_body => '${a.body}', p_category => '${a.cat}', p_area_ids => ${areas},
    p_expires_at => ${a.exp}, p_starts_at => ${a.start}, p_link_url => ${a.link === 'null' ? 'null' : `'${a.link}'`}, p_action_text => ${a.act === 'null' ? 'null' : a.act}, p_is_essential => ${a.ess}, p_review_at => ${a.ess ? a.review : 'null'})`);
  return failed(out) ? out : idOf(out);
};
const essentialIds = (who: Parameters<typeof as>[0] = 'anon', areas = 'null') => { const o = as(who, `select id from public.get_essential_alerts(${areas})`); if (failed(o)) throw new Error(o); return o.split('\n').filter((l) => /^[0-9a-f-]{36}$/.test(l.trim())); };
const status = (id: string) => scalar(`select status from notices where id='${id}'`);
const audit = (event: string, extra = '') => Number(scalar(`select count(*) from notice_audit_log where event='${event}' ${extra}`));

before(() => {
  buildDatabase(2);
  LEGACY_BEFORE = scalar(`select md5(row(${ORIG})::text) from notices where id='${N_LEGACY}'`);
  AREAS = areaIds();
  const kid = raw(`select a.id || ',' || a.parent_id from areas a join areas p on p.id = a.parent_id where p.type = 'locality' and a.is_active limit 1`).split(',');
  CHILD = kid[0]; CHILD_PARENT = kid[1];
});

describe('administrator-only control of organisations and the entitlement', () => {
  test('1 nobody but a platform administrator can create, verify, add members or grant/revoke (moderator, hub owner, urgent business, council user included)', () => {
    for (const who of ['A', 'O', 'H', 'V', 'P'] as const) {
      assert.match(as(who, `select public.admin_upsert_official_publisher('x-org','X','other')`), /Platform administrators only/, who);
      assert.match(as(who, `select public.admin_list_official_publishers()`), /Platform administrators only/, who);
      assert.match(as(who, `select public.admin_notice_audit(10)`), /Platform administrators only/, who);
    }
    assert.match(as('anon', `select public.admin_upsert_official_publisher('x-org','X','other')`), /permission denied|Platform administrators only/);
  });
  test('2 the organisation tables, grants and audit log are unreadable and unwritable by clients', () => {
    for (const t of ['official_publishers', 'official_publisher_members', 'essential_alert_grants', 'notice_audit_log']) {
      assert.match(as('A', `select count(*) from ${t}`), /permission denied/, t);
      assert.match(as('S', `select count(*) from ${t}`), /permission denied/, `${t} even for an administrator (use the functions)`);
      assert.match(as('P', `insert into ${t} default values`), /permission denied/, t);
    }
  });
  test('3 an administrator creates the Council and NHS organisations; nothing is verified, active-granted or assigned yet', () => {
    const c = as('S', `select public.admin_upsert_official_publisher('shetland-islands-council','Shetland Islands Council','council','https://www.shetland.gov.uk',null)`);
    assert.ok(!failed(c), c); COUNCIL = idOf(c);
    const h = as('S', `select public.admin_upsert_official_publisher('nhs-shetland','NHS Shetland','health','https://www.nhsshetland.scot.nhs.uk',null)`);
    assert.ok(!failed(h), h); NHS = idOf(h);
    assert.match(COUNCIL, /^[0-9a-f-]{36}$/); assert.match(NHS, /^[0-9a-f-]{36}$/);
    assert.equal(scalar(`select count(*) from essential_alert_grants`), '0');
    assert.equal(scalar(`select count(*) from official_publisher_members`), '0');
    assert.equal(scalar(`select count(*) from official_publishers where verified_at is not null`), '0');
  });
  test('4 an unverified organisation cannot publish, even for an authorised member; verification needs a note', () => {
    assert.ok(!failed(as('S', `select public.admin_set_official_publisher_member('${COUNCIL}','${U.P}','publisher')`)));
    assert.ok(!failed(as('S', `select public.admin_set_official_publisher_member('${COUNCIL}','${U.D}','delegate')`)));
    assert.match(publish('P'), /not authorised to publish for that organisation/);
    assert.match(as('S', `select public.admin_verify_official_publisher('${COUNCIL}','')`), /Say how/);
    assert.ok(!failed(as('S', `select public.admin_verify_official_publisher('${COUNCIL}','Verified by call-back to the published switchboard number, 31 Oct')`)));
    assert.ok(!failed(as('S', `select public.admin_verify_official_publisher('${NHS}','Verified by call-back to the published switchboard number, 31 Oct')`)));
    assert.ok(!failed(as('S', `select public.admin_set_official_publisher_member('${NHS}','${U.N}','publisher')`)));
  });
  test('5 the entitlement: needs a reason, a verified active organisation with a publisher member; one active grant; audited; the NHS does not hold it', () => {
    assert.match(as('S', `select public.admin_grant_essential_alert('${COUNCIL}','')`), /A reason is required/);
    assert.match(as('A', `select public.admin_grant_essential_alert('${COUNCIL}','because')`), /Platform administrators only/);
    assert.ok(!failed(as('S', `select public.admin_grant_essential_alert('${COUNCIL}','Council is the approved first Essential Alert publisher')`)));
    assert.match(as('S', `select public.admin_grant_essential_alert('${COUNCIL}','again')`), /duplicate key|one_active/);
    assert.equal(scalar(`select count(*) from essential_alert_grants where revoked_at is null`), '1');
    assert.equal(audit('essential_granted'), 1);
    assert.equal(asScalar('P', `select can_essential::text from public.my_official_publishers()`), 'true');
    assert.equal(asScalar('D', `select can_essential::text from public.my_official_publishers()`), 'false');
    assert.equal(asScalar('N', `select can_essential::text from public.my_official_publishers()`), 'false');
    assert.equal(asScalar('A', `select count(*) from public.my_official_publishers()`), '0');
  });
  test('6 the entitlement cannot be granted to an unverified organisation or one with no authorised publisher', () => {
    const bo = as('S', `select public.admin_upsert_official_publisher('scottish-water','Scottish Water','utility')`);
    assert.ok(!failed(bo), bo); const bare = idOf(bo);
    assert.match(as('S', `select public.admin_grant_essential_alert('${bare}','x')`), /verified, active/);
    as('S', `select public.admin_verify_official_publisher('${bare}','Verified by call-back, 31 Oct')`);
    assert.match(as('S', `select public.admin_grant_essential_alert('${bare}','x')`), /at least one authorised publisher/);
  });
});

describe('publishing an organisation notice and designating an Essential Alert', () => {
  let ESS = '', ORD = '';
  test('7 a Council publisher publishes an ordinary official notice: published, public, a platform notice issued by the organisation, not essential', () => {
    ORD = publish('P', { title: 'Bin collection changes over the holiday period', body: 'Collections move by one day for the week of the holiday; please put bins out the night before.', cat: 'public_services', act: 'null', areas: [AREAS[0]] });
    assert.match(ORD, /^[0-9a-f-]{36}$/, ORD);
    assert.equal(scalar(`select is_platform_notice::text || is_essential::text || severity || status from notices where id='${ORD}'`), 'truefalseinfopublished');
    assert.equal(asScalar('anon', `select count(*) from notices where id='${ORD}'`), '1');
    assert.equal(scalar(`select public.notice_publisher_display('${ORD}')->>'byline'`), 'Issued by Shetland Islands Council');
    assert.equal(scalar(`select publisher_user_id is null from notices where id='${ORD}'`), 't', 'the delegate/publisher account is not exposed on the public row');
  });
  test('8 the same publisher marks ONE notice essential deliberately; the ordinary one stays ordinary (entitlement does not promote everything)', () => {
    ESS = publish('P', { ess: true });
    assert.match(ESS, /^[0-9a-f-]{36}$/, ESS);
    assert.equal(scalar(`select is_essential::text || severity from notices where id='${ESS}'`), 'trueurgent');
    assert.deepEqual(essentialIds(), [ESS]);
    assert.equal(scalar(`select is_essential::text from notices where id='${ORD}'`), 'false');
    assert.equal(audit('essential_published'), 1);
    assert.equal(scalar(`select count(*) from notice_areas where notice_id='${ESS}' and area_id='shetland_wide'`), '1');
  });
  test('9 a delegate can publish ordinary official notices but NOT an essential alert; the NHS (no entitlement) cannot; nobody else can', () => {
    assert.match(publish('D', { ess: true, title: 'Delegate tries essential' }), /cannot issue Essential Alerts/);
    assert.match(publish('N', { pub: NHS, ess: true, title: 'NHS tries essential' }), /cannot issue Essential Alerts/);
    assert.match(publish('A', { ess: true }), /not authorised/);
    assert.match(publish('H', { ess: true }), /not authorised/);
    assert.match(publish('V', { ess: true }), /not authorised/);
    assert.match(publish('S', { ess: true }), /not authorised/, 'an administrator is not a Council publisher: they use the entitlement admin functions');
    assert.match(publish('anon'), /permission denied|not authorised/);
    const d = publish('D', { title: 'Delegate ordinary notice' });
    assert.match(d, /^[0-9a-f-]{36}$/, d);
    const nhs = publish('N', { pub: NHS, title: 'Flu vaccination clinics this month', body: 'Clinics run at the health centres across the isles this month; please book through your practice.', cat: 'health', act: 'null' });
    assert.match(nhs, /^[0-9a-f-]{36}$/, nhs);
    assert.equal(scalar(`select count(*) from public.get_public_notices('official', null, null, 50) where publisher->>'label' = 'NHS Shetland' and level = 2`), '1', 'a routine NHS notice is Level 2');
    assert.ok(!essentialIds().includes(nhs));
  });
  test('10 no client can write an essential or organisation field directly, by insert OR update, whoever they are (administrator, hub owner, can_publish_urgent business)', () => {
    for (const who of ['A', 'H', 'V', 'S', 'O'] as const) {
      const cols = who === 'V' ? `publisher_business_id, ` : who === 'H' ? `publisher_hub_id, ` : ``;
      const vals = who === 'V' ? `'${BIZ_V}', ` : who === 'H' ? `'${HUB_V}', ` : ``;
      assert.match(as(who, `insert into notices (${cols}severity, title, body, is_essential) values (${vals}'urgent','Fake essential','A long enough body for the constraint to be tempted',true)`), REFUSED, who);
      assert.match(as(who, `insert into notices (${cols}title, body, official_publisher_id) values (${vals}'Fake org','Body',  '${COUNCIL}')`), REFUSED, who);
      assert.match(as(who, `insert into notices (${cols}title, body, action_text) values (${vals}'Fake','Body','do something now please')`), REFUSED, who);
    }
    assert.match(as('S', `update notices set is_essential = false where id='${ESS}'`), /set only by an authorised|You no longer manage|row-level security/);
    assert.match(as('S', `update notices set official_publisher_id = '${NHS}' where id='${ORD}'`), /cannot be changed|set only by an authorised|You no longer manage|row-level security/);
    as('P', `update notices set title = 'hijacked' where id='${ESS}'`);   // RLS hides the row from a direct UPDATE: nothing changes (asserted below)
    assert.equal(scalar(`select title from notices where id='${ESS}'`), 'Road closed at Voe junction');
  });
  test('11 the old can_publish_urgent permission is NOT converted: an urgent business notice works as before and is never an Essential Alert', () => {
    const id = idOf(as('V', `insert into notices (id, publisher_business_id, severity, title, body) values (gen_random_uuid(), '${BIZ_V}', 'urgent', 'Garage closed today', 'Back tomorrow') returning id`));
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(scalar(`select severity || is_essential::text from notices where id='${id}'`), 'urgentfalse');
    assert.ok(!essentialIds().includes(id));
    assert.equal(scalar(`select level from public.get_public_notices('all') where id='${id}'`), '3');
  });
  test('12 server-side validation of an essential alert (areas, expiry, review time, action, body, https link, categories) — every rule refuses', () => {
    const bad: [string, Partial<Parameters<typeof publish>[1]>, RegExp][] = [
      ['no areas', { areas: [] }, /at least one affected area/],
      ['unknown area', { areas: ['atlantis'] }, /Unknown or inactive area/],
      ['wide + specific', { areas: ['shetland_wide', AREAS[0]] }, /cannot be combined/],
      ['no expiry', { exp: 'null' }, /needs an expiry/],
      ['expiry beyond 7 days', { exp: "now() + interval '8 days'" }, /more than 7 days/],
      ['no review time', { ess: true, review: 'null' }, /review time/],
      ['review after expiry', { review: "now() + interval '3 days'" }, /review time/],
      ['no action', { act: 'null' }, /what people need to do/],
      ['short action', { act: "'Do it'" }, /what people need to do/],
      ['short body', { body: 'Too short.' }, /explanation/],
      ['http link', { link: 'http://example.org/a' }, /plain https/],
      ['credentials link', { link: 'https://user:pw@example.org/a' }, /plain https/],
      ['javascript link', { link: 'javascript:alert(1)' }, /plain https/],
      ['bad category', { cat: 'made_up' }, /valid category/],
      ['starts too far ahead', { start: "now() + interval '40 days'" }, /next 30 days/],
    ];
    for (const [label, o, re] of bad) assert.match(publish('P', { ess: true, ...o }), re, label);
    assert.match(publish('P', { ess: true, link: 'https://www.shetland.gov.uk/roads/closures' }), /^[0-9a-f-]{36}$/, 'a plain https source link is accepted');
  });
  test('13 CHECK constraints make an essential row impossible without its essentials, even for a migration or the service role', () => {
    const ins = (cols: string, vals: string) => file(`insert into notices (is_platform_notice, official_publisher_id, is_essential, severity, ${cols}) values (true, '${COUNCIL}', true, ${vals})`);
    assert.match(ins('title, body, expires_at, review_at', `'urgent','Valid title','A sufficiently long body text here', now()+interval '1 day', now()`), /notices_essential_check/, 'missing action');
    assert.match(ins('title, body, action_text, expires_at, review_at', `'info','Valid title','A sufficiently long body text here','Do this thing now', now()+interval '1 day', now()`), /notices_essential_check/, 'not urgent');
    assert.match(ins('title, body, action_text', `'urgent','Valid title','A sufficiently long body text here','Do this thing now'`), /notices_essential_check/, 'no expiry/review');
    assert.match(file(`insert into notices (is_platform_notice, source, source_reference, source_label, source_url, expires_at, is_essential, severity, title, body, action_text, review_at, official_publisher_id)
      values (true,'x','1','X','https://x.example',now()+interval '1 day',true,'urgent','Valid title','A sufficiently long body text here','Do this thing now',now(),'${COUNCIL}')`), /notices_(official_publisher_check|essential_check)/, 'an import can never be essential');
  });
});

describe('only an ACTIVE essential alert is ever an Essential Alert', () => {
  const mk = () => publish('P', { ess: true, title: `Alert ${Math.random().toString(36).slice(2, 8)}` });
  const fresh = () => { const id = mk(); assert.match(id, /^[0-9a-f-]{36}$/, id); return id; };
  test('14 expired, resolved, withdrawn, hidden, scheduled and past-review alerts are not returned (and not as essential in get_public_notices)', () => {
    const cases: [string, (id: string) => void][] = [
      ['expired', (id) => raw(`update notices set expires_at = now() - interval '1 minute', review_at = now() - interval '2 minutes' where id='${id}'`)],
      ['resolved', (id) => { assert.ok(!failed(as('P', `select public.official_set_notice_status('${id}','resolved')`))); }],
      ['withdrawn', (id) => { assert.ok(!failed(as('P', `select public.official_set_notice_status('${id}','withdrawn')`))); }],
      ['hidden', (id) => raw(`update notices set is_hidden = true where id='${id}'`)],
      ['scheduled', (id) => raw(`update notices set starts_at = now() + interval '1 hour' where id='${id}'`)],
      ['past review', (id) => raw(`update notices set review_at = now() - interval '1 minute' where id='${id}'`)],
    ];
    for (const [label, mutate] of cases) {
      const id = fresh();
      assert.ok(essentialIds().includes(id), `${label}: alert should be active before`);
      mutate(id);
      assert.ok(!essentialIds().includes(id), `${label}: must not be an active Essential Alert`);
      assert.notEqual(scalar(`select coalesce((select level from public.get_public_notices('all', null, null, 50) where id='${id}'),9)`), '1', label);
    }
  });
  test('15 resolving removes the prominent placement, stamps resolved_at, and is audited; the notice is no longer public (old clients cannot label resolved)', () => {
    const id = fresh();
    as('P', `select public.official_set_notice_status('${id}','resolved')`);
    assert.equal(status(id), 'resolved');
    assert.equal(scalar(`select (resolved_at is not null)::text from notices where id='${id}'`), 'true');
    assert.equal(asScalar('anon', `select count(*) from notices where id='${id}'`), '0');
    assert.ok(audit('notice_resolved', `and notice_id='${id}'`) >= 1);
  });
  test('16 correction: the issuing organisation can correct a live alert (audited, still essential, area list replaceable); another organisation cannot touch it', () => {
    const id = fresh();
    assert.ok(!failed(as('P', `select public.official_update_notice(p_notice => '${id}', p_title => 'Road reopened with a single lane', p_area_ids => array['${AREAS[0]}']::text[])`)));
    assert.equal(scalar(`select title from notices where id='${id}'`), 'Road reopened with a single lane');
    assert.equal(scalar(`select string_agg(area_id, ',') from notice_areas where notice_id='${id}'`), AREAS[0]);
    assert.ok(audit('notice_corrected', `and notice_id='${id}'`) >= 1);
    assert.match(as('N', `select public.official_update_notice(p_notice => '${id}', p_title => 'Hijacked by the NHS')`), /not authorised/);
    assert.match(as('N', `select public.official_set_notice_status('${id}','withdrawn')`), /not authorised/);
    assert.match(as('D', `select public.official_update_notice(p_notice => '${id}', p_is_essential => true, p_title => 'Delegate keeps it essential?')`), /cannot issue Essential Alerts/, 'a delegate cannot edit an essential alert');
    assert.match(as('P', `select public.official_update_notice(p_notice => '${id}', p_expires_at => now() + interval '30 days')`), /more than 7 days/, 'a correction cannot stretch an essential alert past the rule');
    assert.equal(scalar(`select is_essential::text from notices where id='${id}'`), 'true');
  });
  test('17 revoking the entitlement demotes live essential alerts to ordinary official notices (kept, readable, no longer top priority); the publisher cannot issue another; re-grant works', () => {
    const id = fresh();
    assert.match(as('P', `select public.admin_revoke_essential_alert('${COUNCIL}','x')`), /Platform administrators only/);
    assert.match(as('S', `select public.admin_revoke_essential_alert('${COUNCIL}','')`), /A reason is required/);
    const demoted = asScalar('S', `select public.admin_revoke_essential_alert('${COUNCIL}','Contact no longer authorised to issue alerts')`);
    assert.ok(Number(demoted) >= 1, demoted);
    assert.equal(scalar(`select is_essential::text || status || severity from notices where id='${id}'`), 'falsepublishedinfo');
    assert.deepEqual(essentialIds(), []);
    assert.equal(asScalar('anon', `select count(*) from notices where id='${id}'`), '1', 'still publicly readable');
    assert.equal(scalar(`select level from public.get_public_notices('all', null, null, 50) where id='${id}'`), '2');
    assert.match(publish('P', { ess: true }), /cannot issue Essential Alerts/);
    assert.equal(audit('essential_revoked'), 1);
    assert.ok(audit('essential_demoted') >= 1);
    assert.ok(!failed(as('S', `select public.admin_grant_essential_alert('${COUNCIL}','Re-granted after review')`)));
    assert.equal(scalar(`select count(*) from essential_alert_grants where publisher_id='${COUNCIL}'`), '2');
  });
  test('18 removing a member ends their authority immediately but leaves their notices live; an administrator can still resolve them', () => {
    const id = fresh();
    assert.ok(!failed(as('S', `select public.admin_set_official_publisher_member('${COUNCIL}','${U.P}','publisher', false)`)));
    assert.match(publish('P', { ess: true }), /not authorised/);
    assert.match(as('P', `select public.official_set_notice_status('${id}','resolved')`), /not authorised/);
    assert.ok(essentialIds().includes(id));
    assert.ok(!failed(as('S', `select public.official_set_notice_status('${id}','resolved')`)));
    assert.ok(!essentialIds().includes(id));
    as('S', `select public.admin_set_official_publisher_member('${COUNCIL}','${U.P}','publisher', true)`);
    assert.ok(audit('member_removed') >= 1);
  });
  test('19 an organisation that is deactivated cannot publish and its alerts stop being essential', () => {
    const id = fresh();
    as('S', `select public.admin_set_official_publisher_active('${COUNCIL}', false)`);
    assert.ok(!essentialIds().includes(id));
    assert.match(publish('P', {}), /not authorised/);
    as('S', `select public.admin_set_official_publisher_active('${COUNCIL}', true)`);
    assert.ok(essentialIds().includes(id));
  });
});

describe('the public read functions', () => {
  test('20 levels partition the public feed: essential / official (organisation + import) / community, with essential first in "all"', () => {
    const imp = file(`insert into notices (is_platform_notice, source, source_reference, source_label, source_url, expires_at, title, body, severity)
      values (true,'sic_council','ref-1','Shetland Islands Council (Official Notices)','https://www.shetland.gov.uk/n/1', now()+interval '3 days','Imported council notice','Summary of an imported council notice.','info') returning id`);
    const impId = idOf(imp);
    assert.equal(scalar(`select level from public.get_public_notices('all', null, null, 50) where id='${impId}'`), '2');
    assert.equal(scalar(`select level from public.get_public_notices('all', null, null, 50) where id='${N_LEGACY}'`), '3');
    const ess = publish('P', { ess: true, title: 'Ordering check alert' });
    const all = as('anon', `select id from public.get_public_notices('all', null, null, 50)`).split('\n').filter((l) => /^[0-9a-f-]{36}$/.test(l));
    assert.equal(all[0].length, 36);
    assert.ok(all.indexOf(ess) < all.indexOf(N_LEGACY), 'an essential alert sorts above community notices');
    for (const lvl of ['essential', 'official', 'community']) {
      const want = { essential: '1', official: '2', community: '3' }[lvl];
      assert.equal(asScalar('anon', `select count(*) filter (where level <> ${want}) from public.get_public_notices('${lvl}', null, null, 50)`), '0', lvl);
    }
    assert.match(as('anon', `select * from public.get_public_notices('bogus')`), /Unknown level/);
  });
  test('21 area semantics: null = unfiltered; empty = Shetland-wide only; a specific area gets its own, its parent\'s and its children\'s notices plus Shetland-wide', () => {
    const wide = publish('P', { title: 'Wide official notice here', areas: ['shetland_wide'], ess: false, act: 'null' });
    const here = publish('P', { title: 'Locality official notice', areas: [CHILD_PARENT], ess: false, act: 'null' });
    const kid = publish('P', { title: 'Settlement official notice', areas: [CHILD], ess: false, act: 'null' });
    const other = publish('P', { title: 'Other locality notice', areas: [AREAS.find((a) => a !== CHILD_PARENT)!], ess: false, act: 'null' });
    const ids = (arr: string) => as('anon', `select id from public.get_public_notices('official', ${arr}, null, 50)`).split('\n').filter((l) => /^[0-9a-f-]{36}$/.test(l));
    const forKid = ids(`array['${CHILD}']::text[]`);
    assert.ok(forKid.includes(wide) && forKid.includes(kid) && forKid.includes(here), 'child follower gets wide + own + parent');
    assert.ok(!forKid.includes(other), 'a different locality is excluded');
    const forParent = ids(`array['${CHILD_PARENT}']::text[]`);
    assert.ok(forParent.includes(kid) && forParent.includes(here) && forParent.includes(wide), 'parent follower also gets the notice for a place inside it');
    const none = ids(`array[]::text[]`);
    assert.ok(none.includes(wide) && !none.includes(here) && !none.includes(kid) && !none.includes(other), 'no areas selected = Shetland-wide only, NOT everything');
    assert.ok(ids('null').includes(other), 'null = unfiltered');
  });
  test('22 non-public notices never appear: pending, withdrawn, resolved, hidden, scheduled, expired — for any level, area or category', () => {
    const base = `insert into notices (publisher_hub_id, title, body, severity, visibility, status, is_hidden, starts_at, expires_at) values ('${HUB_V}'`;
    const rows: [string, string][] = [
      ['pending', `'NEVER pending','b','info','public','pending',false,null,null`], ['withdrawn', `'NEVER withdrawn','b','info','public','withdrawn',false,null,null`],
      ['resolved', `'NEVER resolved','b','info','public','resolved',false,null,null`], ['hidden', `'NEVER hidden','b','info','public','published',true,null,null`],
      ['scheduled', `'NEVER scheduled','b','info','public','published',false,${now_plus('1 hour')},null`], ['expired', `'NEVER expired','b','info','public','published',false,null,${now_plus('-1 hour')}`],
      ['members-only', `'NEVER members','b','info','members','published',false,null,null`],
    ];
    for (const [, v] of rows) assert.ok(!failed(file(`${base}, ${v})`)), v);
    for (const lvl of ['all', 'essential', 'official', 'community']) assert.equal(asScalar('anon', `select count(*) from public.get_public_notices('${lvl}', null, null, 50) where title like 'NEVER%'`), '0', lvl);
    assert.equal(asScalar('anon', `select count(*) from notices where title like 'NEVER%'`), '0', 'and the table read is unchanged');
  });
  test('23 pagination and limits: limit is clamped, offset pages without repeats', () => {
    const p1 = as('anon', `select id from public.get_public_notices('all', null, null, 2, 0)`).split('\n').filter((l) => /^[0-9a-f-]{36}$/.test(l));
    const p2 = as('anon', `select id from public.get_public_notices('all', null, null, 2, 2)`).split('\n').filter((l) => /^[0-9a-f-]{36}$/.test(l));
    assert.equal(p1.length, 2); assert.equal(p2.length, 2);
    assert.equal(new Set([...p1, ...p2]).size, 4);
    assert.equal(asScalar('anon', `select count(*) from public.get_public_notices('all', null, null, 5000, 0)`) <= '50', true);
  });
  test('24 a person notice keeps its privacy-safe attribution through the new read function (approved + public only)', () => {
    const id = idOf(file(`insert into notices (is_person_notice, publisher_user_id, severity, title, body, status) values (true,'${U.A}','info','Lost a tabby cat near the harbour','Answers to Biscuit.','published') returning id`));
    assert.equal(scalar(`select publisher->>'kind' || ':' || (publisher->>'label') from public.get_public_notices('community', null, null, 50) where id='${id}'`), 'person:Ann');
    const pend = idOf(file(`insert into notices (is_person_notice, publisher_user_id, severity, title, body, status) values (true,'${U.A2}','info','Pending person notice','Not yet approved.','pending') returning id`));
    assert.equal(scalar(`select count(*) from public.get_public_notices('all', null, null, 50) where id='${pend}'`), '0');
  });
});

describe('old clients and existing behaviour', () => {
  test('25 the legacy notice is byte-identical in every original column and still public', () => {
    assert.equal(scalar(`select md5(row(${ORIG})::text) from notices where id='${N_LEGACY}'`), LEGACY_BEFORE);
    assert.equal(asScalar('anon', `select count(*) from notices where id='${N_LEGACY}'`), '1');
  });
  test('26 an old client\'s hub notice (original columns only) still publishes immediately and is public; a plain member still cannot', () => {
    const id = idOf(as('H', `insert into notices (id, publisher_hub_id, title, body) values (gen_random_uuid(), '${HUB_V}', 'Old-style hub notice', 'Body') returning id`));
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(status(id), 'published');
    assert.match(as('M', `insert into notices (publisher_hub_id, title, body) values ('${HUB_V}', 'Member notice', 'Body')`), /do not manage|row-level security/);
  });
  test('27 an old client reading the table directly sees only public rows with the new columns merely extra (no resolved / pending / withdrawn alert)', () => {
    assert.equal(asScalar('anon', `select count(*) from notices where status <> 'published' or is_hidden`), '0');
    assert.equal(asScalar('anon', `select count(*) from notices where is_essential and status <> 'published'`), '0');
    assert.equal(asScalar('anon', `select count(*) from information_schema.columns where table_name='notices' and column_name in ('is_essential','action_text')`), '2');
  });
  test('28 the audit log is append-only even for the database owner, and records who did what', () => {
    assert.match(file(`update notice_audit_log set event = 'essential_granted' where id = (select min(id) from notice_audit_log)`), /append-only/);
    assert.match(file(`delete from notice_audit_log`), /append-only/);
    assert.match(file(`truncate notice_audit_log`), /append-only/);
    assert.ok(Number(scalar(`select count(*) from notice_audit_log where actor_id is not null`)) > 5);
    assert.equal(scalar(`select count(*) from notice_audit_log where event='essential_published' and publisher_id='${COUNCIL}' and notice_id is not null`) >= '1', true);
    const n = asScalar('S', `select count(*) from public.admin_notice_audit(500)`);
    assert.ok(Number(n) > 10, n);
  });
  test('29 the guard is load-bearing: with the essential guard trigger dropped, a client could set is_essential (so its absence would be caught)', () => {
    file(`alter table notices disable trigger notices_essential_guard`);
    try {
      // with only the attribution guard left, a hub owner can still not write a platform/essential row, but the essential columns themselves are no longer protected:
      const o = as('H', `insert into notices (id, publisher_hub_id, title, body, action_text) values (gen_random_uuid(), '${HUB_V}', 'Probe', 'Body', 'do something now please') returning id`);
      assert.ok(!failed(o), 'the field guard is what stops this write');
    } finally { file(`alter table notices enable trigger notices_essential_guard`); }
    assert.match(as('H', `insert into notices (publisher_hub_id, title, body, action_text) values ('${HUB_V}', 'Probe2', 'Body', 'do something now please')`), /set only by an authorised/);
  });
});

function now_plus(i: string) { return `now() + interval '${i}'`; }
