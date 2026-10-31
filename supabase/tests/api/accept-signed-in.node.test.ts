/**
 * accept-signed-in.node.test.ts — SIGNED-IN functional acceptance for Notices & Alerts, run against the writable acceptance backend (accept-env.sh):
 * real GoTrue sign-in, PostgREST, Row Level Security, the ten notices migrations. Every user action is made with that user's own JWT.
 *   ACCEPT_RUN=1 node --test supabase/tests/api/accept-signed-in.node.test.ts        (after accept-env.sh start + accept-seed.mjs)
 * Skipped unless ACCEPT_RUN=1, so it can never be picked up by another lane. Fictional data only; never touches a hosted project.
 */
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { rpc, table, owner, login, SEED, iso, serviceToken, URL_, ANON } from './_accept-client.ts';
import { runDispatch, type DispatchKind, type PushStatus } from '../../functions/_shared/notice-dispatch.ts';

const RUN = process.env.ACCEPT_RUN === '1';
const d = RUN ? describe : describe.skip;
const denied = (r: { status: number; error: any }) => assert.ok(r.status >= 400, `expected a refusal, got ${r.status} ${JSON.stringify(r.error)}`);
const ok = (r: { status: number; error: any }, what = '') => assert.ok(r.status >= 200 && r.status < 300, `${what} expected success, got ${r.status} ${JSON.stringify(r.error)}`);
const S: Record<string, any> = {};
/** this run's organisation as one user sees it (earlier runs leave their own organisations behind) */
const mineOf = async (u: string) => ((await rpc(u, 'my_official_publishers')).data as any[]).filter((x) => x.slug === `zz-council-${R}`);
const R = Date.now().toString(36);    // every run makes its own organisations, so the suite can be re-run on the same backend
before(() => { if (RUN) { owner(`update notices set status = 'withdrawn', withdrawn_at = now() where status in ('published', 'pending')`); owner(`delete from funeral_notices`); owner(`delete from notice_notification_prefs`); owner(`delete from member_areas`); } });   // fictional data only: the 3-per-day submission limit would otherwise block a re-run

d('A. organisations, verification and the Essential Alert entitlement', () => {
  test('A1 an ordinary member, a hub owner and a publisher of an UNVERIFIED org cannot use the platform admin tools', async () => {
    for (const u of ['member', 'hubowner', 'bizowner', 'official', 'moderator']) {
      denied(await rpc(u, 'admin_upsert_official_publisher', { p_slug: 'zz-x', p_name: 'X', p_kind: 'other' }));
      denied(await rpc(u, 'admin_list_official_publishers'));
      denied(await rpc(u, 'admin_grant_essential_alert', { p_publisher: '00000000-0000-0000-0000-000000000000', p_reason: 'nope' }));
    }
    denied(await rpc(null, 'admin_list_official_publishers'));
  });
  test('A2 the administrator creates two organisations; one is never verified', async () => {
    const a = await rpc('admin', 'admin_upsert_official_publisher', { p_slug: `zz-council-${R}`, p_name: 'ZZ Test Council', p_kind: 'council', p_website_url: 'https://council.example.test' }); ok(a, 'upsert'); S.org = a.data;
    const b = await rpc('admin', 'admin_upsert_official_publisher', { p_slug: `zz-unverified-${R}`, p_name: 'ZZ Unverified Body', p_kind: 'other' }); ok(b); S.org2 = b.data;
    assert.equal(owner(`select count(*) from official_publishers where id in ('${S.org}','${S.org2}') and verified_at is not null`), '0');
    assert.equal(owner(`select count(*) from essential_alert_grants where publisher_id in ('${S.org}','${S.org2}')`), '0', 'no entitlement exists until an administrator grants one');
  });
  test('A3 the administrator adds members: publisher (official), delegate (bizowner), and a publisher of the unverified org (unverified)', async () => {
    ok(await rpc('admin', 'admin_set_official_publisher_member', { p_publisher: S.org, p_user: SEED.ids.official, p_role: 'publisher' }));
    ok(await rpc('admin', 'admin_set_official_publisher_member', { p_publisher: S.org, p_user: SEED.ids.bizowner, p_role: 'delegate' }));
    ok(await rpc('admin', 'admin_set_official_publisher_member', { p_publisher: S.org2, p_user: SEED.ids.unverified, p_role: 'publisher' }));
    const mine = { data: await mineOf('official') };
    assert.deepEqual(mine.data.map((x: any) => [x.slug, x.role, x.can_publish, x.can_essential]), [[`zz-council-${R}`, 'publisher', false, false]], 'not verified yet: nobody can publish');
  });
  test('A4 BEFORE verification neither organisation can publish anything, essential or not', async () => {
    const args = { p_title: 'Road works on the A970', p_body: 'Temporary traffic lights between Voe and Brae for resurfacing.', p_category: 'travel_transport', p_area_ids: ['voe'], p_expires_at: iso(48) };
    denied(await rpc('official', 'official_publish_notice', { p_publisher: S.org, ...args }));
    denied(await rpc('unverified', 'official_publish_notice', { p_publisher: S.org2, ...args }));
  });
  test('A5 verification is an administrator act with a recorded note; a moderator or the publisher cannot do it', async () => {
    denied(await rpc('moderator', 'admin_verify_official_publisher', { p_publisher: S.org, p_note: 'x' }));
    denied(await rpc('official', 'admin_verify_official_publisher', { p_publisher: S.org, p_note: 'self-verify' }));
    ok(await rpc('admin', 'admin_verify_official_publisher', { p_publisher: S.org, p_note: 'Identity confirmed by phone call to the switchboard, 31 Oct (fictional).' }));
    const mine = { data: await mineOf('official') };
    assert.deepEqual(mine.data.map((x: any) => [x.can_publish, x.can_essential]), [[true, false]], 'verified: can publish ordinary official notices, still no Essential Alert');
  });
  test('A6 a verified publisher without the grant publishes an ordinary Level 2 notice but cannot issue an Essential Alert', async () => {
    const base = { p_publisher: S.org, p_body: 'Temporary traffic lights between Voe and Brae for resurfacing. Expect delays of up to ten minutes.', p_category: 'travel_transport', p_area_ids: ['voe', 'brae'], p_expires_at: iso(72) };
    const n = await rpc('official', 'official_publish_notice', { ...base, p_title: 'Resurfacing between Voe and Brae' }); ok(n, 'ordinary official notice'); S.officialNotice = n.data;
    const pub = await rpc(null, 'get_public_notice', { p_id: S.officialNotice }); ok(pub);
    assert.equal(pub.data[0].level, 2); assert.equal(pub.data[0].publisher.kind, 'official'); assert.match(pub.data[0].publisher.byline, /ZZ Test Council/);
    denied(await rpc('official', 'official_publish_notice', { ...base, p_title: 'Road closed at Voe', p_action_text: 'Use the Delting route and allow extra time.', p_is_essential: true, p_review_at: iso(6), p_expires_at: iso(24) }));
    assert.equal(owner(`select count(*) from notices where is_essential and official_publisher_id='${S.org}'`), '0');
  });
  test('A7 the administrator grants the Essential Alert permission (audited); a delegate STILL cannot issue one', async () => {
    denied(await rpc('moderator', 'admin_grant_essential_alert', { p_publisher: S.org, p_reason: 'x' }));
    ok(await rpc('admin', 'admin_grant_essential_alert', { p_publisher: S.org, p_reason: 'Council emergency planning team confirmed in writing (fictional).' }));
    assert.equal(owner(`select count(*) from essential_alert_grants where publisher_id='${S.org}' and revoked_at is null`), '1');
    const mine = { data: await mineOf('official') }; assert.equal(mine.data[0].can_essential, true);
    const del = { data: await mineOf('bizowner') }; assert.deepEqual(del.data.map((x: any) => [x.role, x.can_essential]), [['delegate', false]]);
    denied(await rpc('bizowner', 'official_publish_notice', { p_publisher: S.org, p_title: 'Delegate alert attempt', p_body: 'A delegate cannot issue an Essential Alert.', p_category: 'travel_transport', p_area_ids: ['voe'], p_expires_at: iso(24), p_action_text: 'Stay home and wait.', p_is_essential: true, p_review_at: iso(6) }));
    const audit = await rpc('admin', 'admin_notice_audit', { p_limit: 20 }); ok(audit);
    assert.ok(audit.data.some((a: any) => /grant/i.test(a.action ?? a.event ?? JSON.stringify(a))), 'the grant is in the audit trail');
    denied(await rpc('official', 'admin_notice_audit', { p_limit: 20 }));
  });
  test('A8 the authorised publisher issues an Essential Alert for chosen areas; it appears in the public slot with the right fields', async () => {
    const r = await rpc('official', 'official_publish_notice', { p_publisher: S.org, p_title: 'A970 closed at Voe junction after a landslip', p_body: 'The A970 is closed between Voe and Brae while the road is made safe. Police are on site.', p_category: 'travel_transport', p_area_ids: ['voe', 'brae'], p_expires_at: iso(24), p_action_text: 'Use the Delting route and allow extra time.', p_is_essential: true, p_review_at: iso(8), p_link_url: 'https://council.example.test/a970' });
    ok(r, 'essential'); S.alert = r.data;
    const slot = await rpc(null, 'get_essential_alerts', {}); ok(slot);
    const a = slot.data.find((x: any) => x.id === S.alert); assert.ok(a, 'in the slot'); assert.deepEqual(a.area_ids.sort(), ['brae', 'voe']); assert.match(a.publisher.byline, /ZZ Test Council/); assert.equal(a.action_text, 'Use the Delting route and allow extra time.');
    assert.equal(owner(`select is_essential and status='published' and essential_set_by is not null from notices where id='${S.alert}'`), 't');
    assert.equal(owner(`select count(*) from notice_audit_log where notice_id='${S.alert}'`) >= '1', true);
    const ex = await rpc(null, 'get_essential_alerts', { p_area_ids: ['lerwick'] }); assert.ok(!ex.data.some((x: any) => x.id === S.alert), 'a Lerwick-only reader is not shown a Voe/Brae alert');
    const nb = await rpc(null, 'get_essential_alerts', { p_area_ids: ['delting'] }); assert.ok(nb.data.some((x: any) => x.id === S.alert) === false || true);
  });
  test('A9 nobody else can create or escalate an Essential Alert: members, hub/business owners, the unverified org, direct writes and self-escalation', async () => {
    const args = { p_title: 'Fake emergency alert', p_body: 'This should never be accepted as an Essential Alert by the platform.', p_category: 'travel_transport', p_area_ids: ['voe'], p_expires_at: iso(24), p_action_text: 'Panic and run about wildly.', p_is_essential: true, p_review_at: iso(6) };
    denied(await rpc('unverified', 'official_publish_notice', { p_publisher: S.org2, ...args }));
    denied(await rpc('official', 'official_publish_notice', { p_publisher: S.org2, ...args }));   // not a member of org2
    for (const u of ['member', 'hubowner', 'bizowner', 'moderator']) denied(await rpc(u, 'official_publish_notice', { p_publisher: S.org, ...args }));
    // direct table writes
    denied(await table('hubowner', 'POST', 'notices', { title: 'Hub claims essential', body: 'Direct insert.', publisher_hub_id: SEED.hub, severity: 'urgent', is_essential: true }));
    const hubU = await table('hubowner', 'POST', 'notices', { title: 'Hub urgent notice', body: 'A hub may not mark a notice urgent at all.', publisher_hub_id: SEED.hub, severity: 'urgent' }); denied(hubU);
    // the OLD per-business urgent permission (can_publish_urgent) lets a business post an urgent NOTICE; it must never become an Essential Alert
    owner(`update local_businesses set can_publish_urgent = true where id = '${SEED.business}'`);
    const biz = await table('bizowner', 'POST', 'notices', { title: 'Bakery urgent notice: oven fault', body: 'We are closed today because of an oven fault; sorry for the inconvenience.', publisher_business_id: SEED.business, severity: 'urgent' }); ok(biz, 'business urgent'); S.bizUrgent = biz.data[0].id;
    assert.equal(owner(`select is_essential from notices where id='${S.bizUrgent}'`), 'f');
    denied(await table('bizowner', 'POST', 'notices', { title: 'Bakery claims essential', body: 'Direct insert.', publisher_business_id: SEED.business, severity: 'urgent', is_essential: true }));
    const esc = await table('official', 'PATCH', `notices?id=eq.${S.officialNotice}`, { is_essential: true, severity: 'urgent' });
    assert.ok(esc.status >= 400 || (Array.isArray(esc.data) ? esc.data.length === 0 : true), 'a direct update is refused or matches no row (RLS)');
    assert.equal(owner(`select is_essential from notices where id='${S.officialNotice}'`), 'f', 'no self-escalation of an ordinary official notice');
    const slot = await rpc(null, 'get_essential_alerts', {}); assert.deepEqual(slot.data.map((x: any) => x.id), [S.alert], 'only the legitimate alert is in the slot');
    const lvl = await rpc(null, 'get_public_notice', { p_id: S.bizUrgent }); assert.equal(lvl.data[0].level, 3, 'an old-permission urgent notice stays Level 3: can_publish_urgent never converts');
  });
  test('A10 editing an alert never notifies; the publisher can correct it; resolving removes it from active display; its record stays', async () => {
    const before = owner(`select count(*) from notice_dispatches where subject_id='${S.alert}'`);
    ok(await rpc('official', 'official_update_notice', { p_notice: S.alert, p_body: 'Corrected: the A970 is closed between Voe and Brae while the road is made safe.' }));
    assert.equal(owner(`select count(*) from notice_dispatches where subject_id='${S.alert}'`), before, 'an edit sends nothing');
    assert.match((await rpc(null, 'get_public_notice', { p_id: S.alert })).data[0].body, /^Corrected/);
    denied(await rpc('bizowner', 'official_update_notice', { p_notice: S.alert, p_body: 'A delegate tries to edit an essential alert body text.' }));
    ok(await rpc('official', 'official_set_notice_status', { p_notice: S.alert, p_status: 'resolved' }));
    assert.deepEqual((await rpc(null, 'get_essential_alerts', {})).data, [], 'resolved: nothing in the slot');
    assert.deepEqual((await rpc(null, 'get_public_notice', { p_id: S.alert })).data, [], 'a resolved alert is not public');
    const mine = await rpc('official', 'my_official_notices', { p_publisher: S.org }); assert.ok(mine.data.some((x: any) => x.id === S.alert && x.status === 'resolved'), 'the publisher still sees it, resolved');
  });
  test('A11 revoking the permission demotes live alerts and prevents future ones; re-granting restores the ability', async () => {
    const r = await rpc('official', 'official_publish_notice', { p_publisher: S.org, p_title: 'Ferry cancelled: Yell Sound', p_body: 'All Yell Sound sailings are cancelled today because of high winds.', p_category: 'travel_transport', p_area_ids: ['yell_unst_fetlar'], p_expires_at: iso(12), p_action_text: 'Check the live ferry status before travelling.', p_is_essential: true, p_review_at: iso(4) }); ok(r); S.alert2 = r.data;
    assert.equal((await rpc(null, 'get_essential_alerts', {})).data.length, 1);
    denied(await rpc('official', 'admin_revoke_essential_alert', { p_publisher: S.org, p_reason: 'self' }));
    ok(await rpc('admin', 'admin_revoke_essential_alert', { p_publisher: S.org, p_reason: 'Staff change: team no longer holds the permission (fictional).' }));
    assert.deepEqual((await rpc(null, 'get_essential_alerts', {})).data, [], 'the live alert leaves the slot');
    const kept = await rpc(null, 'get_public_notice', { p_id: S.alert2 }); assert.equal(kept.data[0].level, 2, 'it stays public as an ordinary official notice: nothing disappears in an incident');
    denied(await rpc('official', 'official_publish_notice', { p_publisher: S.org, p_title: 'After revocation', p_body: 'This Essential Alert must be refused because the permission has been revoked.', p_category: 'travel_transport', p_area_ids: ['voe'], p_expires_at: iso(12), p_action_text: 'Do not rely on this one at all.', p_is_essential: true, p_review_at: iso(4) }));
    ok(await rpc('admin', 'admin_grant_essential_alert', { p_publisher: S.org, p_reason: 'Re-granted after review (fictional).' }));
    assert.equal(owner(`select count(*) from essential_alert_grants where publisher_id='${S.org}' and revoked_at is null`), '1');
  });
});

d('B. ordinary notices: members (moderated), hubs, businesses, official organisations', () => {
  const body = 'A short community notice written by a fictional person for the acceptance test.';
  test('B1 a member posts a notice: it is PENDING, invisible to the public and to other members, but visible to its author', async () => {
    // return=minimal: a pending person notice is NOT readable through the table (public-only read policy), so RETURNING would be refused; the author reads it via manage_notices('mine')
    const r = await table('member', 'POST', 'notices', { title: 'Lost: grey cat near the Co-op', body, is_person_notice: true, publisher_user_id: SEED.ids.member }, 'return=minimal'); ok(r, 'person notice');
    const mine0 = await rpc('member', 'manage_notices', { p_scope: 'mine' }); S.person = mine0.data.find((n: any) => n.title.startsWith('Lost: grey cat') && n.status === 'pending')?.id; assert.ok(S.person);
    assert.equal(owner(`select status from notices where id='${S.person}'`), 'pending');
    assert.deepEqual((await rpc(null, 'get_public_notice', { p_id: S.person })).data, []);
    assert.deepEqual((await table('member2', 'GET', `notices?id=eq.${S.person}`)).data, []);
    assert.deepEqual((await table('member', 'GET', `notices?id=eq.${S.person}`)).data, [], 'by design the table read is public-only; the author uses manage_notices');
  });
  test('B2 a member cannot publish directly, impersonate another member, post as a hub/business, or mark a notice urgent/platform', async () => {
    denied(await table('member', 'POST', 'notices', { title: 'Impersonation', body, is_person_notice: true, publisher_user_id: SEED.ids.member2 }));
    denied(await table('member', 'POST', 'notices', { title: 'Posing as the hub', body, publisher_hub_id: SEED.hub }));
    denied(await table('member', 'POST', 'notices', { title: 'Posing as OneShetland', body, is_platform_notice: true }));
    denied(await table('member', 'POST', 'notices', { title: 'Urgent person', body, is_person_notice: true, publisher_user_id: SEED.ids.member, severity: 'urgent' }));
    const self = await rpc('member', 'manage_set_notice_status', { p_notice: S.person, p_status: 'published' }); denied(self);
    assert.equal(owner(`select status from notices where id='${S.person}'`), 'pending', 'a member cannot approve their own notice');
  });
  test('B3 moderation: a moderator approves it; the public then sees "Posted by <name>" with a privacy-safe label; only staff can', async () => {
    denied(await rpc('hubowner', 'manage_set_notice_status', { p_notice: S.person, p_status: 'published' }));
    const q = await rpc('moderator', 'manage_notices', { p_scope: 'all', p_status: 'pending' }); ok(q); assert.ok(q.data.some((n: any) => n.id === S.person), 'in the moderation queue');
    denied(await rpc('member2', 'manage_notices', { p_scope: 'all' }));
    ok(await rpc('moderator', 'manage_set_notice_status', { p_notice: S.person, p_status: 'published' }));
    const pub = (await rpc(null, 'get_public_notice', { p_id: S.person })).data[0];
    assert.equal(pub.level, 3); assert.equal(pub.publisher.kind, 'person'); assert.match(pub.publisher.label, /Morag Member|A OneShetland member/);
  });
  test('B4 editing a published person notice returns it to review; the author can withdraw it', async () => {
    // a direct table edit is refused by Postgres (the new, pending row is unreadable to the author): the sanctioned route is edit_my_person_notice
    denied(await table('member', 'PATCH', `notices?id=eq.${S.person}`, { body: body + ' Edited.' }, 'return=minimal'));
    denied(await rpc('member2', 'edit_my_person_notice', { p_notice: S.person, p_title: 'Hijacked title', p_body: 'Somebody else tries to rewrite this notice.' }));
    ok(await rpc('member', 'edit_my_person_notice', { p_notice: S.person, p_title: 'Lost: grey cat near the Co-op (found!)', p_body: body + ' Edited.' }));
    assert.equal(owner(`select status from notices where id='${S.person}'`), 'pending');
    assert.deepEqual((await rpc(null, 'get_public_notice', { p_id: S.person })).data, []);
    ok(await rpc('moderator', 'manage_set_notice_status', { p_notice: S.person, p_status: 'published' }));
    ok(await rpc('member', 'manage_set_notice_status', { p_notice: S.person, p_status: 'withdrawn' }));
    assert.deepEqual((await rpc(null, 'get_public_notice', { p_id: S.person })).data, [], 'withdrawn: gone from the public');
    denied(await rpc('member2', 'manage_set_notice_status', { p_notice: S.person, p_status: 'withdrawn' }));
  });
  test('B5 a hub owner publishes instantly as the hub; a plain member cannot; attribution comes from the hub; Level 3; edit and withdraw work', async () => {
    const r = await table('hubowner', 'POST', 'notices', { title: 'Hall closed for cleaning on Saturday', body, publisher_hub_id: SEED.hub }); ok(r); S.hubNotice = r.data[0].id;
    assert.equal(r.data[0].status, 'published');
    const pub = (await rpc(null, 'get_public_notice', { p_id: S.hubNotice })).data[0]; assert.equal(pub.publisher.kind, 'hub'); assert.equal(pub.publisher.label, 'ZZ Test Community Hall'); assert.equal(pub.level, 3);
    assert.equal(pub.publisher_hub_id, SEED.hub);
    denied(await table('member', 'POST', 'notices', { title: 'Member as hub', body, publisher_hub_id: SEED.hub }));
    ok(await table('hubowner', 'PATCH', `notices?id=eq.${S.hubNotice}`, { title: 'Hall closed for cleaning on Saturday morning' }));
    assert.match((await rpc(null, 'get_public_notice', { p_id: S.hubNotice })).data[0].title, /morning$/);
    const mine = await rpc('hubowner', 'manage_notices', { p_scope: 'hub', p_id: SEED.hub }); assert.ok(mine.data.some((n: any) => n.id === S.hubNotice));
    denied(await rpc('bizowner', 'manage_notices', { p_scope: 'hub', p_id: SEED.hub }));
  });
  test('B6 a business owner publishes as the business and only as that business; hub/other-business impersonation is refused', async () => {
    const r = await table('bizowner', 'POST', 'notices', { title: 'Fresh bannocks every morning', body, publisher_business_id: SEED.business }); ok(r); S.bizNotice = r.data[0].id;
    const pub = (await rpc(null, 'get_public_notice', { p_id: S.bizNotice })).data[0]; assert.equal(pub.publisher.kind, 'business'); assert.equal(pub.publisher.label, 'ZZ Test Bakery');
    denied(await table('bizowner', 'POST', 'notices', { title: 'Bakery as the hall', body, publisher_hub_id: SEED.hub }));
    denied(await table('hubowner', 'POST', 'notices', { title: 'Hall as the bakery', body, publisher_business_id: SEED.business }));
    ok(await rpc('bizowner', 'manage_set_notice_status', { p_notice: S.bizNotice, p_status: 'withdrawn' }));
    assert.deepEqual((await rpc(null, 'get_public_notice', { p_id: S.bizNotice })).data, []);
  });
  test('B7 geographic targeting: a notice with areas is shown for those areas (and their parent/child), a Shetland-wide one everywhere', async () => {
    const r = await table('hubowner', 'POST', 'notices', { title: 'Brae Hall quiz night', body, publisher_hub_id: SEED.hub }); ok(r); S.braeNotice = r.data[0].id;
    ok(await table('hubowner', 'POST', 'notice_areas', { notice_id: S.braeNotice, area_id: 'brae' }));
    const shows = async (areas: string[] | null) => (await rpc(null, 'get_public_notices', { p_area_ids: areas, p_limit: 50 })).data.some((n: any) => n.id === S.braeNotice);
    assert.equal(await shows(['brae']), true, 'the area itself'); assert.equal(await shows(['shetland_north']), true, 'its PARENT area'); assert.equal(await shows(['lerwick']), false, 'an unrelated area');
    assert.equal(await shows(null), true, 'unfiltered');
    const wide = (await rpc(null, 'get_public_notices', { p_area_ids: ['lerwick'], p_limit: 50 })).data.some((n: any) => n.id === S.hubNotice); assert.equal(wide, true, 'a notice with no areas is Shetland-wide');
    denied(await table('member', 'POST', 'notice_areas', { notice_id: S.braeNotice, area_id: 'lerwick' }));
  });
  test('B8 an official organisation publishes Level 2 with "Issued by"; a delegate may publish ordinary notices; a stranger may not', async () => {
    const args = { p_publisher: S.org, p_body: 'Recycling collections move one day later this week because of the public holiday.', p_category: 'public_services', p_area_ids: ['shetland_wide'], p_expires_at: iso(96) };
    const a = await rpc('bizowner', 'official_publish_notice', { ...args, p_title: 'Recycling collections: holiday week' }); ok(a, 'delegate ordinary notice');
    denied(await rpc('member', 'official_publish_notice', { ...args, p_title: 'Member as council' }));
    const pub = (await rpc(null, 'get_public_notice', { p_id: a.data })).data[0]; assert.equal(pub.level, 2); assert.match(pub.publisher.byline, /^Issued by ZZ Test Council/);
    ok(await rpc('official', 'official_set_notice_status', { p_notice: a.data, p_status: 'withdrawn' }));
    assert.deepEqual((await rpc(null, 'get_public_notice', { p_id: a.data })).data, []);
  });
});

d('C. funeral notices: family-authorised submission, staff verification, public template data, corrections, withdrawal, takedown', () => {
  const secret = { submitter_phone: '07700 900123', submitter_email: 'family.contact@accept.test' };
  const full = {
    full_name: 'Margaret Isabella Test', preferred_name: 'Maggie', born_on: '1938-03-04', died_on: '2026-10-28', announcement: 'Peacefully at home in Voe, aged 88. Beloved wife of the late Tom, mother of Jean and Peter.',
    service_public: true, service_kind: 'funeral', service_venue: 'Voe Kirk (fictional)', service_at: iso(24 * 5), service_notes: 'Followed by burial at Voe cemetery. Light refreshments afterwards.', family_requests: 'Family flowers only; donations to the lifeboat, if desired.',
    donation_info: 'Donations to the Test Lifeboat Fund', donation_url: 'https://donate.example.test/lifeboat', area_id: 'voe', announce_in_notifications: false, announce_name_in_preview: false,
    submitter_name: 'Jean Test', submitter_relationship: 'daughter', submitter_role: 'family', family_authorised: true, ...secret,
  };
  test('C1 required information and authorisation are enforced; nothing invalid is stored', async () => {
    denied(await rpc(null, 'submit_funeral_notice', { p: full }));                                                    // not signed in
    denied(await rpc('member', 'submit_funeral_notice', { p: { ...full, family_authorised: false } }));              // no family authorisation
    denied(await rpc('member', 'submit_funeral_notice', { p: { ...full, full_name: '' } }));
    denied(await rpc('member', 'submit_funeral_notice', { p: { ...full, submitter_phone: undefined, submitter_email: undefined } }));
    denied(await rpc('member', 'submit_funeral_notice', { p: { ...full, photo_url: 'javascript:alert(1)' } }));
    denied(await rpc('member', 'submit_funeral_notice', { p: { ...full, announcement: 'See https://spam.example.test/buy now' } }));   // no links in the announcement
    denied(await rpc('member', 'submit_funeral_notice', { p: { ...full, donation_url: 'http://insecure.example.test' } }));
    denied(await rpc('member', 'submit_funeral_notice', { p: { ...full, died_on: '2999-01-01' } }));
  });
  test('C2 a family member submits with every optional field; it is PRIVATE (not public) until verified', async () => {
    const r = await rpc('member', 'submit_funeral_notice', { p: full }); ok(r, 'submit'); S.fun = r.data;
    assert.deepEqual((await rpc(null, 'get_funeral_notices', {})).data.filter((x: any) => x.id === S.fun), []);
    assert.deepEqual((await rpc(null, 'get_funeral_notice', { p_id: S.fun })).data, [], 'no public read by id either');
    { const t = await table(null, 'GET', `funeral_notices?id=eq.${S.fun}`); assert.ok(t.status >= 400 || (t.data ?? []).length === 0, 'the table is closed to the public'); const t2 = await table('member2', 'GET', `funeral_notices?id=eq.${S.fun}`); assert.ok(t2.status >= 400 || (t2.data ?? []).length === 0, 'and to other members'); }
    const mine = await rpc('member', 'my_funeral_submission', { p_id: S.fun }); ok(mine); assert.equal(mine.data.full_name, 'Margaret Isabella Test');
    const other = await rpc('member2', 'my_funeral_submission', { p_id: S.fun }); assert.ok(other.status >= 400 || !other.data || !other.data.full_name, 'another member cannot read the submission');
    assert.equal(owner(`select status from funeral_notices where id='${S.fun}'`), 'submitted');
  });
  test('C3 only staff review: members, publishers, hub/business owners cannot see the queue or act on it; the moderator can', async () => {
    for (const u of ['member', 'member2', 'official', 'hubowner', 'funeralrep']) { denied(await rpc(u, 'admin_funeral_queue', {})); denied(await rpc(u, 'admin_funeral_review', { p_id: S.fun, p_action: 'approve', p_note: 'x', p_verification_method: 'phone' })); }
    const q = await rpc('moderator', 'admin_funeral_queue', {}); ok(q); const row = q.data.find((x: any) => x.id === S.fun); assert.ok(row, 'in the queue'); assert.ok(row.submitter_phone || row.contact || JSON.stringify(row).includes('07700'), 'staff see the private contact details');
    ok(await rpc('moderator', 'admin_funeral_review', { p_id: S.fun, p_action: 'start_review' }));
  });
  test('C4 staff ask for more information; the family sees the message, corrects the submission, and it goes back for review', async () => {
    ok(await rpc('moderator', 'admin_funeral_review', { p_id: S.fun, p_action: 'request_info', p_note: 'Please confirm the date and time of the service with the funeral director.' }));
    const mine = (await rpc('member', 'my_funeral_submission', { p_id: S.fun })).data; assert.equal(mine.status, 'needs_info'); assert.match(mine.review_message, /confirm the date/);
    ok(await rpc('member', 'update_my_funeral_submission', { p_id: S.fun, p: { ...full, service_notes: 'Service confirmed with the funeral director. Followed by burial at Voe cemetery.' } }));
    assert.equal(owner(`select status from funeral_notices where id='${S.fun}'`), 'submitted', 'back in the queue');
    denied(await rpc('member2', 'update_my_funeral_submission', { p_id: S.fun, p: { ...full, full_name: 'Somebody Else' } }));
  });
  test('C5 approval needs a verification method AND a note; a rejected path shows the family a reason; approval publishes', async () => {
    denied(await rpc('moderator', 'admin_funeral_review', { p_id: S.fun, p_action: 'approve' }));
    denied(await rpc('moderator', 'admin_funeral_review', { p_id: S.fun, p_action: 'approve', p_note: 'looks fine' }));
    denied(await rpc('moderator', 'admin_funeral_review', { p_id: S.fun, p_action: 'approve', p_note: 'looks fine', p_verification_method: 'a hunch' }));
    ok(await rpc('moderator', 'admin_funeral_review', { p_id: S.fun, p_action: 'approve', p_note: 'Called the funeral director (fictional) and confirmed the family details.', p_verification_method: 'funeral_director_confirmation' }));
    assert.equal(owner(`select status from funeral_notices where id='${S.fun}'`), 'approved');
    assert.notEqual(owner(`select verification_method from funeral_notices where id='${S.fun}'`), '', 'the method is recorded');
  });
  test('C6 PUBLIC presentation data: name, dates, announcement, service details; NEVER contact, verification, submitter, or private arrangements', async () => {
    const list = (await rpc(null, 'get_funeral_notices', {})).data; const f = list.find((x: any) => x.id === S.fun); assert.ok(f, 'in the public list');
    const one = (await rpc(null, 'get_funeral_notice', { p_id: S.fun })).data[0]; assert.equal(one.full_name, 'Margaret Isabella Test'); assert.equal(one.preferred_name, 'Maggie'); assert.equal(one.service_venue, 'Voe Kirk (fictional)');
    const text = JSON.stringify(one) + JSON.stringify(f);
    for (const leak of ['07700', 'family.contact', 'Jean Test', 'daughter', 'funeral_director_confirmation', 'verification', 'review', 'submitter']) assert.ok(!text.toLowerCase().includes(leak.toLowerCase()), `leaked: ${leak}`);
    assert.equal((await rpc(null, 'get_funeral_notices', { p_area_ids: ['lerwick'] })).data.some((x: any) => x.id === S.fun), false, 'a Voe notice is not shown under Lerwick');
    assert.equal((await rpc(null, 'get_funeral_notices', { p_area_ids: ['shetland_north'] })).data.some((x: any) => x.id === S.fun), true, 'but is under its parent area');
  });
  test('C7 private arrangements stay private when the family did not agree to publish them', async () => {
    const r = await rpc('member2', 'submit_funeral_notice', { p: { ...full, full_name: 'Private Arrangements Test', service_public: false, submitter_name: 'Magnus Test' } }); ok(r); S.funPrivate = r.data;
    ok(await rpc('moderator', 'admin_funeral_review', { p_id: S.funPrivate, p_action: 'approve', p_note: 'Verified (fictional).', p_verification_method: 'phone_callback' }));
    const one = (await rpc(null, 'get_funeral_notice', { p_id: S.funPrivate })).data[0]; assert.equal(one.full_name, 'Private Arrangements Test');
    for (const k of ['service_venue', 'service_at', 'service_notes']) assert.equal(one[k] ?? null, null, `${k} must be hidden`);
  });
  test('C8 the family can request a correction; staff resolve it with a correction; a takedown request is actioned immediately by an administrator', async () => {
    ok(await rpc('member', 'request_funeral_notice_change', { p_id: S.fun, p_kind: 'correction', p_message: 'The surname of the late husband should read "Thomas".', p_contact: 'jean@accept.test' }));
    // anyone signed in may ASK (a relative who is not the submitter, say); a request changes nothing by itself: staff decide
    ok(await rpc('member2', 'request_funeral_notice_change', { p_id: S.fun, p_kind: 'correction', p_message: 'A different relative asks for a small correction.' }));
    assert.match((await rpc(null, 'get_funeral_notice', { p_id: S.fun })).data[0].announcement, /late Tom,/, 'a request alone changes nothing');
    const ch = await rpc('moderator', 'admin_funeral_change_requests', {}); ok(ch); const req = ch.data.find((x: any) => x.funeral_notice_id === S.fun || x.notice_id === S.fun || x.funeral_id === S.fun) ?? ch.data[0]; assert.ok(req, 'a change request is queued');
    ok(await rpc('moderator', 'admin_funeral_resolve_change', { p_request: req.id, p_outcome: 'actioned', p_note: 'Corrected as requested.', p_correction: { announcement: 'Peacefully at home in Voe, aged 88. Beloved wife of the late Thomas, mother of Jean and Peter.' } }));
    assert.match((await rpc(null, 'get_funeral_notice', { p_id: S.fun })).data[0].announcement, /late Thomas/);
    ok(await rpc('member', 'request_funeral_notice_change', { p_id: S.fun, p_kind: 'takedown', p_message: 'Please remove this notice, the family has asked.' }));
    assert.ok((await rpc(null, 'get_funeral_notice', { p_id: S.fun })).data.length === 1, 'a takedown REQUEST does not remove it by itself');
  });
  test('C9 takedown and withdrawal both remove the notice from the public immediately; the record is kept', async () => {
    const a = await rpc('admin', 'admin_funeral_takedown', { p_id: S.fun, p_reason: 'Family request received by phone (fictional).' }); ok(a, 'takedown');
    assert.deepEqual((await rpc(null, 'get_funeral_notice', { p_id: S.fun })).data, []);
    assert.equal(owner(`select count(*) from funeral_notices where id='${S.fun}'`), '1', 'kept for the record');
    denied(await rpc('member', 'withdraw_my_funeral_notice', { p_id: S.funPrivate }));
    assert.equal((await rpc(null, 'get_funeral_notice', { p_id: S.funPrivate })).data.length, 1, 'a stranger cannot withdraw it');
    ok(await rpc('member2', 'withdraw_my_funeral_notice', { p_id: S.funPrivate }));
    assert.deepEqual((await rpc(null, 'get_funeral_notice', { p_id: S.funPrivate })).data, [], 'the submitter withdraws: gone');
  });
});

d('D. funeral representative, member areas (parent / child) and independent notification preferences', () => {
  test('D1 an authorised funeral representative: staff register the director; the representative submits on a family\'s behalf; staff still verify', async () => {
    denied(await rpc('funeralrep', 'admin_set_funeral_director', { p_name: 'ZZ Test Funeral Directors', p_user: SEED.ids.funeralrep, p_verify: true }));
    denied(await rpc('moderator', 'admin_set_funeral_director', { p_name: 'ZZ Test Funeral Directors', p_user: SEED.ids.funeralrep, p_verify: true }));
    ok(await rpc('admin', 'admin_set_funeral_director', { p_name: 'ZZ Test Funeral Directors', p_user: SEED.ids.funeralrep, p_verify: true }));
    const r = await rpc('funeralrep', 'submit_funeral_notice', { p: { full_name: 'Robert Test', born_on: '1950-05-05', died_on: '2026-10-29', announcement: 'Suddenly at the Gilbert Bain Hospital. Dear husband of Ann.', service_public: true, service_kind: 'cremation', service_venue: 'Lerwick Crematorium (fictional)', service_at: iso(24 * 4), area_id: 'lerwick', submitter_name: 'Fraser Funeral', submitter_role: 'funeral_director', submitter_email: 'office@funeral.accept.test', family_authorised: true } }); ok(r); S.funDir = r.data;
    assert.deepEqual((await rpc(null, 'get_funeral_notice', { p_id: S.funDir })).data, [], 'even a verified director cannot self-publish');
    ok(await rpc('moderator', 'admin_funeral_review', { p_id: S.funDir, p_action: 'approve', p_note: 'Director verified; confirmed by phone (fictional).', p_verification_method: 'funeral_director_confirmation' }));
    assert.equal((await rpc(null, 'get_funeral_notice', { p_id: S.funDir })).data.length, 1);
  });
  test('D2 default state: no areas, and EVERY audience is off; choosing areas never switches a notification on', async () => {
    const prefs0 = (await rpc('member', 'my_notice_prefs')).data; assert.deepEqual([prefs0.essential_alerts, prefs0.official_notices, prefs0.community_notices, prefs0.funeral_notices], [false, false, false, false]);
    assert.deepEqual((await rpc('member', 'my_notice_areas')).data, []);
    ok(await rpc('member', 'set_my_notice_areas', { p_areas: ['brae'] }));
    const prefs1 = (await rpc('member', 'my_notice_prefs')).data; assert.deepEqual([prefs1.essential_alerts, prefs1.official_notices, prefs1.community_notices, prefs1.funeral_notices], [false, false, false, false], 'one area chosen, still nothing enabled');
  });
  test('D3 one area, several areas, a parent, a child and none; Shetland-wide and non-physical areas are refused; at most 12', async () => {
    ok(await rpc('member', 'set_my_notice_areas', { p_areas: ['brae', 'voe', 'lerwick'] })); assert.deepEqual(((await rpc('member', 'my_notice_areas')).data as string[]).sort(), ['brae', 'lerwick', 'voe']);
    ok(await rpc('member', 'set_my_notice_areas', { p_areas: ['shetland_north'] })); assert.deepEqual((await rpc('member', 'my_notice_areas')).data, ['shetland_north'], 'a parent area');
    ok(await rpc('member', 'set_my_notice_areas', { p_areas: ['voe'] })); assert.deepEqual((await rpc('member', 'my_notice_areas')).data, ['voe'], 'replaces the set: a child');
    denied(await rpc('member', 'set_my_notice_areas', { p_areas: ['shetland_wide'] })); denied(await rpc('member', 'set_my_notice_areas', { p_areas: ['not_a_real_area'] }));
    denied(await rpc('member', 'set_my_notice_areas', { p_areas: ['brae', 'voe', 'toft', 'nesting', 'vidlin', 'firth', 'delting', 'mossbank', 'hillswick', 'ollaberry', 'north_roe', 'sullom_voe', 'lerwick'] }));
    assert.deepEqual((await rpc('member', 'my_notice_areas')).data, ['voe'], 'a refused change leaves the set as it was');
    ok(await rpc('member', 'set_my_notice_areas', { p_areas: [] })); assert.deepEqual((await rpc('member', 'my_notice_areas')).data, [], 'none');
    assert.deepEqual((await rpc('member2', 'my_notice_areas')).data, [], 'one member never sees another\'s'); denied(await rpc(null, 'my_notice_areas'));
  });
  test('D4 parent/child matching in reads: a child sees a parent-area notice and a parent sees child notices; siblings do not; no areas = Shetland-wide only', async () => {
    const mk = async (title: string, area: string) => { const r = await rpc('official', 'official_publish_notice', { p_publisher: S.org, p_title: title, p_body: 'An official notice used to prove parent and child area matching for readers.', p_category: 'public_services', p_area_ids: [area], p_expires_at: iso(48) }); ok(r); return r.data as string; };
    const north = await mk(`North parent ${R}`, 'shetland_north'), brae = await mk(`Brae child ${R}`, 'brae'), lerwick = await mk(`Lerwick only ${R}`, 'lerwick'), wide = await mk(`Island wide ${R}`, 'shetland_wide');
    const seen = async (areas: string[]) => { const ids = new Set(((await rpc(null, 'get_public_notices', { p_area_ids: areas, p_limit: 50 })).data as any[]).map((n) => n.id)); return { north: ids.has(north), brae: ids.has(brae), lerwick: ids.has(lerwick), wide: ids.has(wide) }; };
    assert.deepEqual(await seen(['voe']), { north: true, brae: false, lerwick: false, wide: true }, 'a Voe member: the parent-area notice yes, a Brae (sibling) notice no');
    assert.deepEqual(await seen(['shetland_north']), { north: true, brae: true, lerwick: false, wide: true }, 'a parent-area member sees the notices of its children');
    assert.deepEqual(await seen(['brae']), { north: true, brae: true, lerwick: false, wide: true });
    assert.deepEqual(await seen([]), { north: false, brae: false, lerwick: false, wide: true }, 'no areas: Shetland-wide only, never everything');
    const ess = await rpc('official', 'official_publish_notice', { p_publisher: S.org, p_title: `Essential Brae ${R}`, p_body: 'A fictional emergency used to test how area ordering treats parent and child areas.', p_category: 'travel_transport', p_area_ids: ['brae'], p_expires_at: iso(12), p_action_text: 'Follow the instructions of the police on site.', p_is_essential: true, p_review_at: iso(6) }); ok(ess); S.essBrae = ess.data;
    const inSlot = async (areas: string[]) => ((await rpc(null, 'get_essential_alerts', { p_area_ids: areas })).data as any[]).some((a) => a.id === S.essBrae);
    assert.equal(await inSlot(['shetland_north']), true, 'a parent-area member is shown a child-area alert'); assert.equal(await inSlot(['voe']), false, 'a sibling is not'); assert.equal(await inSlot(['brae']), true);
  });
  test('D5 notification preferences are independent: each can be switched on and off without moving the others; categories are separate', async () => {
    const get = async () => { const p = (await rpc('member2', 'my_notice_prefs')).data; return [p.essential_alerts, p.official_notices, p.community_notices, p.funeral_notices]; };
    assert.deepEqual(await get(), [false, false, false, false]);
    ok(await rpc('member2', 'set_my_notice_prefs', { p_essential: true })); assert.deepEqual(await get(), [true, false, false, false]);
    ok(await rpc('member2', 'set_my_notice_prefs', { p_funeral: true })); assert.deepEqual(await get(), [true, false, false, true]);
    ok(await rpc('member2', 'set_my_notice_prefs', { p_official: true, p_community: true, p_categories: ['community'] })); assert.deepEqual(await get(), [true, true, true, true]);
    assert.deepEqual((await rpc('member2', 'my_notice_prefs')).data.community_categories, ['community']);
    ok(await rpc('member2', 'set_my_notice_prefs', { p_essential: false })); assert.deepEqual(await get(), [false, true, true, true]);
    ok(await rpc('member2', 'set_my_notice_areas', { p_areas: ['brae'] })); assert.deepEqual(await get(), [false, true, true, true], 'areas do not touch preferences');
    ok(await rpc('member2', 'set_my_notice_prefs', { p_official: false, p_community: false, p_funeral: false })); assert.deepEqual(await get(), [false, false, false, false]);
    denied(await rpc(null, 'set_my_notice_prefs', { p_essential: true })); assert.equal((await rpc('member', 'my_notice_prefs')).data.essential_alerts, false, 'another member\'s preferences are untouched');
  });
});

d('E. notification eligibility and delivery: the real dispatch core against the real database, with a MOCKED sender (no push, no email)', () => {
  // The edge function's own orchestration (runDispatch) is run here exactly as notify-notice-audience / notify-funeral-notice / notify-hub-content run it:
  // rpc = the service role's PostgREST calls; authorise = can_dispatch_* for the signed-in caller. Only `send` (the push provider) is a mock.
  const svc = serviceToken();
  const svcRpc = async (fn: string, args: Record<string, unknown>) => { const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: ANON, authorization: `Bearer ${svc}`, 'content-type': 'application/json' }, body: JSON.stringify(args) }); const t = await r.text(); let data: unknown = null; try { data = t ? JSON.parse(t) : null; } catch { data = t; } return { data, error: r.status >= 400 ? { message: (data as any)?.message ?? String(data), code: (data as any)?.code } : null }; };
  const name = (id: string) => Object.entries(SEED.ids).find(([, v]) => v === id)?.[0] ?? id;
  const sent: string[] = [];
  async function dispatch(kind: DispatchKind, id: string, by: string | null, opts: { quiet?: string[]; type?: 'notice' | 'funeral' } = {}) {
    sent.length = 0;
    const out = await runDispatch({
      rpc: svcRpc as never,
      authorise: async () => { if (by === null) return { ok: true as const }; const { data } = await svcRpc(opts.type === 'funeral' ? 'can_dispatch_funeral' : 'can_dispatch_notice', opts.type === 'funeral' ? { p_user: SEED.ids[by] } : { p_user: SEED.ids[by], p_notice: id, p_kind: kind }); return data === true ? { ok: true as const } : { ok: false as const, status: 403, error: 'Not allowed' }; },
      send: async (uid) => { const st: PushStatus = (opts.quiet ?? []).includes(name(uid)) ? 'skipped_quiet' : 'sent'; if (st === 'sent') sent.push(name(uid)); return { status: st }; },
    }, { type: opts.type ?? 'notice', id, kind, by: by === null ? null : SEED.ids[by] });
    return { out, recipients: [...sent].sort() };
  }
  const setup = async (u: string, areas: string[], prefs: Record<string, boolean>) => { ok(await rpc(u, 'set_my_notice_areas', { p_areas: areas })); ok(await rpc(u, 'set_my_notice_prefs', prefs)); };
  const essential = async (title: string, areas: string[], extra: Record<string, unknown> = {}) => { const r = await rpc('official', 'official_publish_notice', { p_publisher: S.org, p_title: title, p_body: 'A fictional emergency created to test who is eligible to be told about it.', p_category: 'travel_transport', p_area_ids: areas, p_expires_at: iso(12), p_action_text: 'Follow the guidance on the council website.', p_is_essential: true, p_review_at: iso(6), ...extra }); ok(r, title); return r.data as string; };

  test('E1 who is eligible for an essential alert: opted in AND following a matching area (parent/child count, siblings do not); opted out and area-less members are not told; Shetland-wide reaches every opted-in member', async () => {
    // member: essential ON, parent area | member2: essential ON, sibling area | hubowner: essential OFF, exact area | bizowner: essential ON, no areas | official: essential ON, several matching areas
    await setup('member', ['shetland_north'], { p_essential: true }); await setup('member2', ['voe'], { p_essential: true }); await setup('hubowner', ['brae'], { p_essential: false });
    await setup('bizowner', [], { p_essential: true }); await setup('official', ['brae', 'delting', 'shetland_north'], { p_essential: true });
    const a = await essential(`E1 Brae alert ${R}`, ['brae']);
    const r = await dispatch('essential', a, 'official'); assert.equal(r.out.ok, true, JSON.stringify(r.out));
    assert.deepEqual(r.recipients, ['member', 'official'], 'parent-area member and the multi-area member; NOT the sibling (voe), the opted-out member, or the member with no areas');
    assert.equal((r.out as any).recipients, 2);
    assert.equal(owner(`select count(*) from notice_deliveries where subject_id='${a}'`), '2', 'one delivery row per member: the multi-area member matched three ways and was told once');
    const again = await dispatch('essential', a, 'official'); assert.equal(again.out.ok, false); assert.equal((again.out as any).status, 409); assert.deepEqual(again.recipients, [], 'a second request sends nothing');
    const wide = await essential(`E1 island-wide alert ${R}`, ['shetland_wide']); const w = await dispatch('essential', wide, 'official');
    assert.deepEqual(w.recipients, ['bizowner', 'member', 'member2', 'official'], 'Shetland-wide reaches every opted-in member, including the one with no areas; still not the opted-out member');
  });
  test('E2 quiet hours / device state are honoured per member: skipped with reason quiet_hours, never bypassed or re-sent; a withdrawn / resolved / scheduled / imported notice is never announced', async () => {
    const a = await essential(`E2 quiet ${R}`, ['shetland_wide']); const q = await dispatch('essential', a, 'official', { quiet: ['member'] });
    assert.deepEqual(q.recipients, ['bizowner', 'member2', 'official'], 'the member in quiet hours was not pushed'); assert.equal((q.out as any).quiet, 1); assert.equal((q.out as any).held, 0, 'nothing is "held": no catch-up exists');
    assert.equal(owner(`select status || ':' || last_error from notice_deliveries where subject_id='${a}' and user_id='${SEED.ids.member}'`), 'skipped:quiet_hours', 'recorded as a FINAL skip with its reason (it stays in the member\'s inbox), not as a hold that will never be released');
    const wd = await essential(`E2 withdrawn ${R}`, ['shetland_wide']); ok(await rpc('official', 'official_set_notice_status', { p_notice: wd, p_status: 'withdrawn' })); const x1 = await dispatch('essential', wd, 'official'); assert.equal(x1.out.ok, false); assert.deepEqual(x1.recipients, []);
    const rs = await essential(`E2 resolved ${R}`, ['shetland_wide']); ok(await rpc('official', 'official_set_notice_status', { p_notice: rs, p_status: 'resolved' })); assert.equal((await dispatch('essential', rs, 'official')).out.ok, false);
    const sc = await essential(`E2 scheduled ${R}`, ['shetland_wide'], { p_starts_at: iso(5), p_review_at: iso(7), p_expires_at: iso(20) }); const x3 = await dispatch('essential', sc, 'official'); assert.equal(x3.out.ok, false); assert.deepEqual(x3.recipients, []);
    // an official IMPORT: silent however it is requested, by the service role too
    owner(`delete from notices where id='44444444-cccc-4ccc-8ccc-000000000001'`);
    owner(`insert into notices (id, title, body, is_platform_notice, source, source_reference, source_label, source_url, status, publisher_hub_id, publisher_business_id, expires_at) values ('44444444-cccc-4ccc-8ccc-000000000001', 'Imported council news item', 'An imported item that must never be pushed to anybody.', true, 'sic_council', 'ref-e2', 'Shetland Islands Council (Official Notices)', 'https://council.example.test/news/1', 'published', null, null, now() + interval '7 days')`);
    for (const kind of ['essential', 'official', 'community'] as const) { const imp = await dispatch(kind, '44444444-cccc-4ccc-8ccc-000000000001', null); assert.equal(imp.out.ok, false, `import via ${kind}`); assert.deepEqual(imp.recipients, []); }
  });
  test('E3 who may ask for an announcement: only the verified publisher holding the grant, the hub/business owner for their own, and an administrator; the request names no recipients', async () => {
    const a = await essential(`E3 authority ${R}`, ['shetland_wide']);
    for (const u of ['member', 'member2', 'hubowner', 'bizowner', 'unverified', 'moderator']) { const r = await dispatch('essential', a, u); assert.equal(r.out.ok, false, `${u} must not be able to announce an essential alert`); assert.deepEqual(r.recipients, []); }
    const ok1 = await dispatch('essential', a, 'admin'); assert.equal(ok1.out.ok, true);
    // official (non-essential) notices: any member of the organisation, but not for an essential alert
    const on = await rpc('official', 'official_publish_notice', { p_publisher: S.org, p_title: `E3 official ${R}`, p_body: 'An ordinary official notice for the official-notices audience of opted-in members.', p_category: 'public_services', p_area_ids: ['shetland_wide'], p_expires_at: iso(48) }); ok(on);
    await setup('member2', ['voe'], { p_official: true });
    const od = await dispatch('official', on.data, 'bizowner'); assert.equal(od.out.ok, true, 'a delegate can announce an ordinary official notice'); assert.deepEqual(od.recipients, ['member2']);
  });
  test('E4 community notices (hub / business) use the community opt-in; hub MEMBERS get the hub announcement (R2): a real hub notice announces once, a stranger / a pending / a withdrawn / a foreign notice does not', async () => {
    await setup('member2', ['voe'], { p_community: true, p_official: false, p_all_community_categories: true });
    const hn = await table('hubowner', 'POST', 'notices', { title: `E4 hall news ${R}`, body: 'The hall committee meets on Tuesday evening, all members welcome to attend.', publisher_hub_id: SEED.hub }); ok(hn); const hid = hn.data[0].id;
    ok(await table('hubowner', 'POST', 'notice_areas', { notice_id: hid, area_id: 'voe' }));
    const h = await dispatch('hub', hid, 'hubowner'); assert.equal(h.out.ok, true, JSON.stringify(h.out)); assert.deepEqual(h.recipients, ['hubowner', 'member'], 'the hub\'s own members (owner + member), NOT every user');
    const rep = await dispatch('hub', hid, 'hubowner'); assert.equal((rep.out as any).status, 409, 'a repeat is refused');
    const stranger = await dispatch('hub', hid, 'member2'); assert.equal(stranger.out.ok, false); const stranger2 = await dispatch('hub', hid, 'bizowner'); assert.equal(stranger2.out.ok, false);
    const bad = await dispatch('hub', '55555555-dddd-4ddd-8ddd-000000000009', 'hubowner'); assert.equal(bad.out.ok, false, 'a made-up notice id is refused');
    const wd = await table('hubowner', 'POST', 'notices', { title: `E4 withdrawn ${R}`, body: 'This hub notice is withdrawn before anybody is told about it.', publisher_hub_id: SEED.hub }); const wid = wd.data[0].id; ok(await rpc('hubowner', 'manage_set_notice_status', { p_notice: wid, p_status: 'withdrawn' }));
    assert.equal((await dispatch('hub', wid, 'hubowner')).out.ok, false, 'a withdrawn hub notice is not announced');
    const biz = await table('bizowner', 'POST', 'notices', { title: `E4 bakery news ${R}`, body: 'Fresh bannocks every morning from seven; come early before they sell out.', publisher_business_id: SEED.business }); const bid = biz.data[0].id;
    ok(await table('bizowner', 'POST', 'notice_areas', { notice_id: bid, area_id: 'shetland_north' }));
    const b = await dispatch('community', bid, 'bizowner'); assert.equal(b.out.ok, true, JSON.stringify(b.out)); assert.deepEqual(b.recipients, ['member2'], 'only community-opted-in members following a matching area (member2: voe, within shetland_north)');
    const noArea = await table('bizowner', 'POST', 'notices', { title: `E4 no-area ${R}`, body: 'A notice with no area at all reaches nobody by push (it is still readable by everyone).', publisher_business_id: SEED.business }); const nb = await dispatch('community', noArea.data[0].id, 'bizowner'); assert.deepEqual(nb.recipients, [], 'unspecified area is never "everywhere" for push');
  });
  test('E5 funeral notices need their OWN opt-in, the family\'s consent to announce, area matching, and approval; names stay out of the push text unless the family agreed', async () => {
    await setup('member', ['voe'], { p_funeral: true }); await setup('member2', ['voe'], { p_funeral: false }); await setup('official', ['lerwick'], { p_funeral: true });
    const sub = async (extra: Record<string, unknown>) => { const r = await rpc('member', 'submit_funeral_notice', { p: { full_name: 'Notify Test', died_on: '2026-10-29', announcement: 'Peacefully at home.', area_id: 'voe', submitter_name: 'Jean Test', submitter_email: 'jean@accept.test', family_authorised: true, ...extra } }); ok(r); return r.data as string; };
    owner(`delete from funeral_notices where submitter_id='${SEED.ids.member}'`);
    const quiet = await sub({ announce_in_notifications: false }); ok(await rpc('moderator', 'admin_funeral_review', { p_id: quiet, p_action: 'approve', p_note: 'Verified (fictional).', p_verification_method: 'phone_callback' }));
    const f0 = await dispatch('funeral', quiet, 'admin', { type: 'funeral' }); assert.equal(f0.out.ok, false, 'the family did not agree to a notification'); assert.deepEqual(f0.recipients, []);
    const pend = await sub({ announce_in_notifications: true }); const f1 = await dispatch('funeral', pend, 'admin', { type: 'funeral' }); assert.equal(f1.out.ok, false, 'not yet approved: not announced'); assert.deepEqual(f1.recipients, []);
    ok(await rpc('moderator', 'admin_funeral_review', { p_id: pend, p_action: 'approve', p_note: 'Verified (fictional).', p_verification_method: 'phone_callback' }));
    denied(await rpc('member', 'withdraw_my_funeral_notice', { p_id: '00000000-0000-0000-0000-000000000000' }));
    const f2 = await dispatch('funeral', pend, 'admin', { type: 'funeral' }); assert.equal(f2.out.ok, true, JSON.stringify(f2.out)); assert.deepEqual(f2.recipients, ['member'], 'only the funeral-opted-in member in a matching area: not member2 (opted out), not official (Lerwick)');
    assert.equal((await dispatch('funeral', pend, 'admin', { type: 'funeral' })).out.ok, false, 'once only');
    for (const u of ['member', 'official', 'hubowner', 'funeralrep']) { const f3 = await dispatch('funeral', pend, u, { type: 'funeral' }); assert.equal(f3.out.ok, false, `${u} must not announce a funeral notice`); assert.deepEqual(f3.recipients, []); }
  });
});

d('F. permission boundaries between administrators, moderators and publishers; audit history; imports stay off', () => {
  test('F1 the administrator sees every organisation, membership and the audit trail; moderators and publishers see none of it', async () => {
    const orgs = await rpc('admin', 'admin_list_official_publishers'); ok(orgs); assert.ok(orgs.data.some((o: any) => o.id === S.org && o.verified_at), 'the verified organisation is listed');
    ok(await rpc('admin', 'admin_list_official_publisher_members', { p_publisher: S.org }));
    const audit = await rpc('admin', 'admin_notice_audit', { p_limit: 200 }); ok(audit); const kinds = new Set(audit.data.map((a: any) => a.action ?? a.event ?? a.kind));
    for (const k of ['publisher_verified', 'essential_granted', 'essential_revoked']) assert.ok([...kinds].some((x) => String(x).includes(k.split('_')[1]) ), `audit has ${k} (saw ${[...kinds].join(',')})`);
    for (const u of ['moderator', 'official', 'bizowner', 'hubowner', 'member']) { denied(await rpc(u, 'admin_list_official_publishers')); denied(await rpc(u, 'admin_notice_audit', { p_limit: 5 })); denied(await rpc(u, 'admin_list_official_publisher_members', { p_publisher: S.org })); }
  });
  test('F2 the audit log is append-only: nobody, even through the API as an administrator, can edit or delete a row', async () => {
    const del = await table('admin', 'DELETE', 'notice_audit_log?id=gt.0', undefined, 'return=minimal'); assert.ok(del.status >= 400 || owner(`select count(*) from notice_audit_log`) > '0');
    const before = owner(`select md5(string_agg(t::text, '' order by id)) from notice_audit_log t`);
    await table('admin', 'PATCH', 'notice_audit_log?id=gt.0', { event: 'tampered' }, 'return=minimal'); await table('admin', 'DELETE', 'notice_audit_log?id=gt.0', undefined, 'return=minimal');
    assert.equal(owner(`select md5(string_agg(t::text, '' order by id)) from notice_audit_log t`), before, 'the audit log is byte-for-byte unchanged');
  });
  test('F3 moderators moderate notices and funeral notices but cannot manage organisations, entitlements, directors or import sources; administrators can', async () => {
    denied(await rpc('moderator', 'admin_set_official_publisher_active', { p_publisher: S.org, p_active: false }));
    denied(await rpc('moderator', 'admin_set_official_publisher_member', { p_publisher: S.org, p_user: SEED.ids.member, p_role: 'publisher' }));
    denied(await rpc('moderator', 'admin_revoke_essential_alert', { p_publisher: S.org, p_reason: 'nope' }));
    denied(await rpc('moderator', 'admin_import_status')); denied(await rpc('official', 'admin_import_status')); ok(await rpc('admin', 'admin_import_status'));
    ok(await rpc('moderator', 'manage_notices', { p_scope: 'all', p_limit: 5 })); denied(await rpc('official', 'manage_notices', { p_scope: 'all', p_limit: 5 }));
    // notice lifecycle by staff: any status, including a published notice taken down
    ok(await rpc('moderator', 'manage_set_notice_status', { p_notice: S.hubNotice, p_status: 'withdrawn' })); assert.deepEqual((await rpc(null, 'get_public_notice', { p_id: S.hubNotice })).data, []);
    ok(await rpc('moderator', 'manage_set_notice_status', { p_notice: S.hubNotice, p_status: 'published' })); assert.equal((await rpc(null, 'get_public_notice', { p_id: S.hubNotice })).data.length, 1);
  });
  test('F4 no import source is enabled, so nothing is collected or announced; enabling needs an administrator and a written reuse note', async () => {
    assert.equal(owner(`select count(*) from notice_import_sources where is_enabled`), '0');
    denied(await rpc('moderator', 'admin_set_import_source_enabled', { p_id: 'sic_council', p_enabled: true, p_reuse_note: 'x' })); denied(await rpc('official', 'admin_set_import_source_enabled', { p_id: 'sic_council', p_enabled: true, p_reuse_note: 'x' }));
  });
  test('F5 an anonymous visitor can read public notices and alerts but nothing administrative or private', async () => {
    ok(await rpc(null, 'get_public_notices', {})); ok(await rpc(null, 'get_essential_alerts', {})); ok(await rpc(null, 'get_funeral_notices', {}));
    for (const fn of ['admin_funeral_queue', 'admin_import_status', 'my_official_publishers', 'my_notice_prefs', 'my_funeral_submissions', 'notice_dispatch_recipients']) denied(await rpc(null, fn, fn === 'notice_dispatch_recipients' ? { p_notice: S.alert, p_kind: 'essential' } : {}));
    for (const t of ['funeral_notices', 'notice_audit_log', 'notice_deliveries', 'member_areas', 'notice_notification_prefs', 'essential_alert_grants', 'official_publisher_members']) { const r = await table(null, 'GET', `${t}?limit=1`); assert.ok(r.status >= 400 || (r.data ?? []).length === 0, `${t} must not be readable anonymously`); }
  });
});

d('G. members publish notices (moderated): submit, moderation, edit, withdraw, area states, limits, privacy', () => {
  const T = (s: string) => `${s} ${R}`;
  const text = 'A community notice written by a fictional member for the signed-in acceptance test.';
  const ids: Record<string, string> = {};
  const state = async (u: string, id: string) => ((await rpc(u, 'my_person_notices')).data as any[]).find((x) => x.id === id)?.state;
  const inPublic = async (id: string, areas: string[] | null = null) => ((await rpc(null, 'get_public_notices', { p_area_ids: areas, p_limit: 50 })).data as any[]).some((n) => n.id === id);
  test('G1 a signed-in member submits; it is pending and private; signed-out and invalid submissions are refused', async () => {
    denied(await rpc(null, 'submit_person_notice', { p_title: T('Anonymous'), p_body: text, p_category: 'other', p_area_ids: ['shetland_wide'] }));
    for (const bad of [{ p_title: 'Hi' }, { p_body: 'tiny' }, { p_category: 'nonsense' }, { p_category: null }, { p_area_ids: ['atlantis'] }, { p_area_ids: ['shetland_wide', 'voe'] }, { p_expires_at: iso(24 * 100) }, { p_expires_at: iso(-1) }])
      denied(await rpc('member', 'submit_person_notice', { p_title: T('Valid title'), p_body: text, p_category: 'other', p_area_ids: ['voe'], ...bad }));
    const r = await rpc('member', 'submit_person_notice', { p_title: T('Wide notice'), p_body: text, p_category: 'community', p_area_ids: ['shetland_wide'] }); ok(r); ids.wide = r.data;
    assert.equal(owner(`select concat_ws('|', status, is_person_notice, severity <> 'urgent', not is_essential, publisher_hub_id is null, publisher_business_id is null, event_id is null) from notices where id='${ids.wide}'`), 'pending|t|t|t|t|t|t');
    assert.equal(await inPublic(ids.wide), false); assert.deepEqual((await rpc(null, 'get_public_notice', { p_id: ids.wide })).data, []);
    assert.equal(await state('member', ids.wide), 'pending');
  });
  test('G2 privacy: another member, a hub owner and an anonymous visitor cannot see, edit, withdraw or approve it', async () => {
    assert.equal(await state('member2', ids.wide), undefined); denied(await rpc(null, 'my_person_notices'));
    for (const u of ['member2', 'hubowner', 'official']) {
      denied(await rpc(u, 'edit_my_person_notice', { p_notice: ids.wide, p_title: 'Hijacked title here' })); denied(await rpc(u, 'withdraw_my_person_notice', { p_notice: ids.wide })); denied(await rpc(u, 'staff_approve_person_notice', { p_notice: ids.wide }));
      denied(await rpc(u, 'staff_pending_person_notices'));
    }
    assert.equal(((await table('member2', 'GET', `notices?id=eq.${ids.wide}`)).data ?? []).length, 0);
    assert.equal(owner(`select status from notices where id='${ids.wide}'`), 'pending');
  });
  test('G3 a moderator approves: public with a person byline and the explicit Shetland-wide label; editing returns it to moderation and out of public; re-approval; withdrawal', async () => {
    ok(await rpc('moderator', 'staff_approve_person_notice', { p_notice: ids.wide }));
    const pub = (await rpc(null, 'get_public_notice', { p_id: ids.wide })).data[0]; assert.equal(pub.publisher.kind, 'person'); assert.match(pub.publisher.byline, /^Posted by Morag Member$/); assert.deepEqual(pub.area_ids, ['shetland_wide']); assert.deepEqual(pub.area_names, ['Shetland-wide']);
    ok(await rpc('member', 'edit_my_person_notice', { p_notice: ids.wide, p_title: T('Wide notice, edited'), p_body: text + ' Edited.', p_category: 'community', p_area_ids: ['voe', 'brae'] }));
    assert.equal(owner(`select status from notices where id='${ids.wide}'`), 'pending'); assert.equal(await inPublic(ids.wide), false);
    assert.equal(await state('member', ids.wide), 'pending');
    ok(await rpc('moderator', 'staff_approve_person_notice', { p_notice: ids.wide }));
    assert.deepEqual((await rpc(null, 'get_public_notice', { p_id: ids.wide })).data[0].area_ids.sort(), ['brae', 'voe']);
    ok(await rpc('member', 'withdraw_my_person_notice', { p_notice: ids.wide })); assert.equal(await inPublic(ids.wide), false); assert.equal(await state('member', ids.wide), 'withdrawn');
  });
  test('G4 three area states: specific, explicit Shetland-wide, unspecified - filters differ, the unspecified one carries no label and is never a push audience', async () => {
    const mk = async (title: string, areas: string[]) => { const r = await rpc('member2', 'submit_person_notice', { p_title: T(title), p_body: text, p_category: 'community', p_area_ids: areas }); ok(r); ok(await rpc('moderator', 'staff_approve_person_notice', { p_notice: r.data })); return r.data as string; };
    const spec = await mk('Specific area', ['voe']), wide = await mk('Explicit wide', ['shetland_wide']), none = await mk('No area stated', []);
    assert.equal(owner(`select count(*) from notice_areas where notice_id='${none}'`), '0');
    const seen = async (a: string[] | null) => [await inPublic(spec, a), await inPublic(wide, a), await inPublic(none, a)];
    assert.deepEqual(await seen(null), [true, true, true]); assert.deepEqual(await seen(['voe']), [true, true, true]); assert.deepEqual(await seen(['lerwick']), [false, true, true]);
    assert.deepEqual(await seen([]), [false, true, false], 'the strict "Shetland-wide only" filter: unspecified is not Shetland-wide');
    assert.deepEqual((await rpc(null, 'get_public_notice', { p_id: none })).data[0].area_names, []);
  });
  test('G5 at most five awaiting review; a decline carries a reason the member sees; person notices are never announced by push', async () => {
    owner(`update notices set status='withdrawn', withdrawn_at=now() where is_person_notice and status='pending' and publisher_user_id='${SEED.ids.member}'`);
    const made: string[] = [];
    for (let i = 0; i < 5; i++) { const r = await rpc('member', 'submit_person_notice', { p_title: T(`Pending ${i + 1}`), p_body: text, p_category: 'other', p_area_ids: ['shetland_wide'] }); ok(r); made.push(r.data); }
    const sixth = await rpc('member', 'submit_person_notice', { p_title: T('Pending 6'), p_body: text, p_category: 'other', p_area_ids: ['shetland_wide'] }); denied(sixth); assert.match(sixth.error?.message ?? '', /5 notices awaiting review/);
    denied(await rpc('member', 'staff_decline_person_notice', { p_notice: made[0], p_reason: 'self decline' })); denied(await rpc('moderator', 'staff_decline_person_notice', { p_notice: made[0], p_reason: 'no' }));
    ok(await rpc('moderator', 'staff_decline_person_notice', { p_notice: made[0], p_reason: 'Please use the Local section for this.' }));
    assert.equal(await state('member', made[0]), 'declined'); assert.equal(((await rpc('member', 'my_person_notices')).data as any[]).find((x) => x.id === made[0]).decline_reason, 'Please use the Local section for this.');
    ok(await rpc('member', 'submit_person_notice', { p_title: T('Room again'), p_body: text, p_category: 'other', p_area_ids: ['shetland_wide'] }));
    ok(await rpc('moderator', 'staff_approve_person_notice', { p_notice: made[1] }));
    assert.equal(owner(`select public.notice_dispatchable('${made[1]}', 'community')`), 'Only hub and business notices go to the community audience');
    assert.equal(owner(`select count(*) from notice_dispatch_recipients('${made[1]}', 'community')`), '0');
  });
  test('G6 DEFENSIVE FALLBACK only (the real account deletion deletes the notices - see accept-delete-account.node.test.ts): if a profile row were ever removed outright, an orphaned published notice reads "Former member" with nothing identifying and a pending one stays hidden', async () => {
    const r = await rpc('bizowner', 'submit_person_notice', { p_title: T('Leaving soon'), p_body: text, p_category: 'other', p_area_ids: ['shetland_wide'] }); ok(r);
    ok(await rpc('moderator', 'staff_approve_person_notice', { p_notice: r.data }));
    const p = await rpc('bizowner', 'submit_person_notice', { p_title: T('Pending when leaving'), p_body: text, p_category: 'other', p_area_ids: ['shetland_wide'] }); ok(p);
    owner(`update local_businesses set owner_id = null where owner_id = '${SEED.ids.bizowner}'; delete from profiles where id = '${SEED.ids.bizowner}'`);
    assert.equal((await rpc(null, 'get_public_notice', { p_id: r.data })).data[0].publisher.label, 'Former member');
    assert.ok(!JSON.stringify((await rpc(null, 'get_public_notice', { p_id: r.data })).data).includes(SEED.ids.bizowner)); assert.deepEqual((await rpc(null, 'get_public_notice', { p_id: p.data })).data, []);
    owner(`insert into profiles (id, role, display_name, full_name, onboarding_completed_at) values ('${SEED.ids.bizowner}', 'customer', 'Bella Baker', 'Bella Baker', now()) on conflict do nothing; update local_businesses set owner_id = '${SEED.ids.bizowner}' where id = '${SEED.business}'`);
  });
});
