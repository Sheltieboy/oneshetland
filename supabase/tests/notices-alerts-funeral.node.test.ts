/**
 * notices-alerts-funeral.node.test.ts — Notices & Alerts step 4: Deaths & Funeral Notices, proven in an ISOLATED Postgres.
 *
 * PROVES: nothing is public until a moderator has recorded HOW it was verified (the authorisation tick-box is never proof); the private fields (submitter,
 * contact, verification, moderator notes) are never returned by any public function and the tables are unreadable by every client role; funeral arrangements
 * are public only when the family explicitly approved that; every optional field is genuinely optional; funeral directors are administrator-granted and a user
 * cannot claim the role; submission is rate-limited; the submitter may amend only an unpublished notice and may withdraw at any time; corrections and takedown
 * requests go to staff; takedown is immediate and audited; notifications carry only what the family approved (discreet by default, a name only with consent),
 * go only to members who opted in to funeral announcements, and cannot repeat; a funeral notice is never in `notices`, never essential, never visible to an old
 * client. ALL identities are fictional. SAFETY — ISOLATED DATABASE ONLY; nothing is sent.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildDatabase, U, as, asScalar, raw, file, scalar, failed, idOf, areaIds, uuid } from './_support/notices-alerts-harness.ts';

type R = Parameters<typeof as>[0];
let AREA = '', AREA2 = '', DIR = '';
const M1 = uuid(), M2 = uuid(), M3 = uuid();
const base = (o: Record<string, unknown> = {}) => JSON.stringify({ full_name: 'Mairi Testfixture', submitter_name: 'Jo Testfixture', submitter_relationship: 'Daughter', submitter_phone: '01595 000000', family_authorised: true, ...o });
const submit = (who: R, o: Record<string, unknown> = {}) => { const out = as(who, `select public.submit_funeral_notice('${base(o).replace(/'/g, "''")}'::jsonb)`); return failed(out) ? out : idOf(out); };
const review = (who: R, id: string, action: string, note: string | null = null, method: string | null = null) =>
  as(who, `select public.admin_funeral_review('${id}','${action}', ${note === null ? 'null' : `'${note}'`}, ${method === null ? 'null' : `'${method}'`})`);
const approve = (id: string) => { const r = review('O', id, 'approve', 'Called the submitter back on the number given and confirmed with the funeral director', 'phone_callback'); assert.ok(!failed(r), r); return id; };
const pub = (areas = 'null') => as('anon', `select id from public.get_funeral_notices(${areas}, 50, 0)`).split('\n').filter((l) => /^[0-9a-f-]{36}$/.test(l.trim())).map((l) => l.trim());
const status = (id: string) => scalar(`select status from funeral_notices where id='${id}'`);
const auditCount = (event: string, id: string) => Number(scalar(`select count(*) from notice_audit_log where event='${event}' and funeral_id='${id}'`));

before(() => {
  buildDatabase(4);
  const a = areaIds(); AREA = a[0]; AREA2 = a[1];
  for (const [i, u] of [M1, M2, M3].entries()) file(`insert into profiles (id, role, display_name) values ('${u}','customer','Member ${i}')`);
});

describe('submission and verification', () => {
  test('1 sign-in, the authorisation tick, a contact route, a real area and a sane date are required; every other field is genuinely optional', () => {
    assert.match(as('anon', `select public.submit_funeral_notice('${base()}'::jsonb)`), /permission denied|Sign in/);
    assert.match(submit('A', { family_authorised: false }), /confirm you are authorised/);
    assert.match(submit('A', { submitter_phone: undefined }), /funeral_contact_present/);
    assert.match(submit('A', { area_id: 'atlantis' }), /real Shetland area/);
    assert.match(submit('A', { died_on: '2999-01-01' }), /cannot be in the future/);
    assert.match(submit('A', { announcement: 'Visit www.cheap-flowers.example now' }), /violates check/);
    assert.match(submit('A', { photo_url: 'http://example.org/p.jpg' }), /violates check/);
    const min = submit('A');                                   // ONLY the required fields
    assert.match(min, /^[0-9a-f-]{36}$/, min);
    assert.equal(status(min), 'submitted');
    assert.equal(scalar(`select (born_on is null and died_on is null and announcement is null and photo_url is null and not service_public and service_at is null and donation_info is null and area_id is null and not announce_in_notifications)::text from funeral_notices where id='${min}'`), 'true');
  });
  test('2 nothing is public before approval — submitted, in review, needs information, rejected — and the tables are unreadable by any client, an administrator included', () => {
    const id = submit('A2', { full_name: 'Not Yet Published' });
    assert.ok(!pub().includes(id));
    review('O', id, 'start_review'); assert.equal(status(id), 'in_review'); assert.ok(!pub().includes(id));
    review('O', id, 'request_info', 'Please confirm the service date'); assert.equal(status(id), 'needs_info'); assert.ok(!pub().includes(id));
    const rej = submit('A2', { full_name: 'Rejected Notice' }); review('O', rej, 'reject', 'Could not verify'); assert.equal(status(rej), 'rejected'); assert.ok(!pub().includes(rej));
    for (const who of ['anon', 'A', 'S', 'O', 'F'] as const) for (const t of ['funeral_notices', 'funeral_change_requests', 'funeral_directors', 'funeral_director_members']) {
      assert.match(as(who, `select count(*) from ${t}`), /permission denied/, `${who} ${t}`);
    }
  });
  test('3 approval cannot rest on the tick-box: a verification method AND note are mandatory, only staff may approve, and the database refuses an unverified approval even to its owner', () => {
    const id = submit('A3', { full_name: 'Needs Verification' });
    assert.match(review('O', id, 'approve'), /Record how the announcement was verified/);
    assert.match(review('O', id, 'approve', null, 'phone_callback'), /Record how/);
    assert.match(review('O', id, 'approve', 'Looks fine'), /Record how/);
    for (const who of ['A3', 'A', 'H', 'anon'] as const) assert.match(review(who, id, 'approve', 'x', 'phone_callback'), /Staff only|permission denied/, who);
    assert.equal(status(id), 'submitted');
    assert.match(raw(`update funeral_notices set status='approved' where id='${id}'`), /funeral_approved_needs_verification/);
    approve(id); assert.equal(status(id), 'approved');
    assert.equal(scalar(`select (verified_by is not null and verified_at is not null and verification_method = 'phone_callback')::text from funeral_notices where id='${id}'`), 'true');
    assert.ok(pub().includes(id));
    assert.ok(auditCount('funeral_submitted', id) === 1 && auditCount('funeral_published', id) === 1);
  });
  test('4 funeral directors are administrator-granted only: a user cannot claim the role, an unverified firm is refused, an authorised account may submit as a director (still moderated)', () => {
    assert.match(submit('F', { submitter_role: 'funeral_director' }), /not an authorised funeral director/);
    assert.match(as('A', `select public.admin_set_funeral_director('Fictional Funeral Directors', '${U.F}')`), /Platform administrators only/);
    assert.match(as('O', `select public.admin_set_funeral_director('Fictional Funeral Directors', '${U.F}')`), /Platform administrators only/, 'a moderator cannot grant it');
    DIR = idOf(as('S', `select public.admin_set_funeral_director('Fictional Funeral Directors', '${U.F}', false)`));
    assert.match(submit('F', { submitter_role: 'funeral_director' }), /not an authorised funeral director/, 'granted but not yet verified');
    file(`update funeral_directors set verified_at = now() where id = '${DIR}'`);
    const id = submit('F', { submitter_role: 'funeral_director', full_name: 'Director Submitted' });
    assert.match(id, /^[0-9a-f-]{36}$/, id);
    assert.equal(status(id), 'submitted');
    assert.equal(scalar(`select (funeral_director_id is not null)::text from funeral_notices where id='${id}'`), 'true');
  });
  test('5 submissions are rate limited: 3 per account per 24 hours', () => {
    for (let i = 0; i < 3; i++) assert.match(submit('H', { full_name: `Rate Probe ${i}` }), /^[0-9a-f-]{36}$/);
    assert.match(submit('H', { full_name: 'Rate Probe 4' }), /3 notices in the last 24 hours/);
  });
});

describe('what the public sees (and never sees)', () => {
  let FULL = '', PRIV = '';
  before(() => {
    FULL = approve(submit('B', { full_name: 'Public Arrangements', preferred_name: 'Peerie Mairi', born_on: '1938-03-02', died_on: '2026-10-28', announcement: 'Peacefully at home, surrounded by family.',
      service_public: true, service_kind: 'funeral', service_venue: 'Fictional Kirk, Voe', service_at: '2026-11-06T11:00:00Z', service_notes: 'Followed by tea in the hall.',
      family_requests: 'Family flowers only.', donation_info: 'Donations to the Fictional Lifeboat Fund.', donation_url: 'https://example.org/donate', area_id: AREA }));
    PRIV = approve(submit('V', { full_name: 'Private Arrangements', service_public: false, service_kind: 'funeral', service_venue: 'Secret Venue', service_at: '2026-11-07T10:00:00Z', service_notes: 'Family only', area_id: AREA2 }));
  });
  test('6 an approved notice shows its public content; arrangements show ONLY when the family approved publishing them', () => {
    const row = (id: string) => JSON.parse(asScalar('anon', `select to_jsonb(g)::text from public.get_funeral_notices(null, 50, 0) g where g.id = '${id}'`));
    const f = row(FULL);
    assert.equal(f.full_name, 'Public Arrangements'); assert.equal(f.preferred_name, 'Peerie Mairi'); assert.equal(f.service_venue, 'Fictional Kirk, Voe');
    assert.equal(f.family_requests, 'Family flowers only.'); assert.equal(f.donation_url, 'https://example.org/donate');
    const p = row(PRIV);
    assert.equal(p.full_name, 'Private Arrangements');
    assert.equal(p.service_venue, null); assert.equal(p.service_at, null); assert.equal(p.service_notes, null); assert.equal(p.service_kind, null);
  });
  test('7 no public function returns a private field (submitter, contact, verification, moderator notes) and the kept-private arrangements appear nowhere in the output', () => {
    const keys = JSON.parse(asScalar('anon', `select (select jsonb_agg(k) from jsonb_object_keys(to_jsonb(g)) k)::text from public.get_funeral_notices(null, 1, 0) g limit 1`)) as string[];
    for (const k of keys) assert.doesNotMatch(k, /submitter|verif|review|phone|email|funeral_director|family_authorised/, k);
    for (const bad of ['Jo Testfixture', '01595 000000', 'Secret Venue', 'Called the submitter back', 'Daughter', 'Family only']) {
      assert.equal(asScalar('anon', `select coalesce((select string_agg(to_jsonb(g)::text, '') from public.get_funeral_notices(null, 50, 0) g) like '%${bad}%', false)`), 'f', bad);
      assert.equal(asScalar('anon', `select coalesce((select string_agg(to_jsonb(g)::text, '') from public.get_funeral_notice('${FULL}') g) like '%${bad}%', false)`), 'f', bad);
    }
  });
  test('8 notices expire from public view; area filtering follows the shared semantics (null = all, [] = area-less only, an area plus its neighbourhood)', () => {
    assert.ok(pub().includes(FULL) && pub().includes(PRIV));
    assert.ok(pub(`array['${AREA}']::text[]`).includes(FULL) && !pub(`array['${AREA}']::text[]`).includes(PRIV));
    assert.ok(!pub(`array[]::text[]`).includes(FULL), 'a notice with an area is not in the "no areas" set');
    const nowhere = approve(submit('C', { full_name: 'No Area Notice' }));
    assert.ok(pub(`array['${AREA}']::text[]`).includes(nowhere) && pub(`array[]::text[]`).includes(nowhere), 'an area-less notice appears everywhere');
    raw(`update funeral_notices set display_until = now() - interval '1 minute' where id='${PRIV}'`);
    assert.ok(!pub().includes(PRIV), 'expired');
    assert.equal(asScalar('anon', `select count(*) from public.get_funeral_notice('${PRIV}')`), '0');
  });
  test('9 a funeral notice is NEVER a row in `notices`, never essential, no level or feed function returns one, and the nine canonical categories are untouched', () => {
    assert.equal(scalar(`select count(*) from notices where title ilike '%Arrangements%' or body ilike '%Arrangements%'`), '0');
    assert.equal(scalar(`select count(*) from public.get_public_notices('all', null, null, 50) where title ilike '%Arrangements%'`), '0');
    assert.equal(scalar(`select count(*) from information_schema.columns where table_name='notices' and column_name ilike '%funeral%'`), '0');
    assert.equal(scalar(`select count(*) from notice_categories`), '9');
    assert.equal(scalar(`select count(*) from notice_categories where id ilike '%funeral%' or id ilike '%death%'`), '0');
  });
});

describe('moderation, corrections and takedown', () => {
  test('10 needs-information round trip: the submitter sees the message and nothing private, amends, and returns to the queue; an in-review or published notice cannot be self-edited', () => {
    const id = submit('M', { full_name: 'Round Trip' });
    review('O', id, 'start_review');
    assert.match(as('M', `select public.update_my_funeral_submission('${id}', '{"announcement":"x"}'::jsonb)`), /can no longer be edited/);
    review('O', id, 'request_info', 'Please confirm the date of the service');
    assert.equal(asScalar('M', `select review_message from public.my_funeral_submissions() where id='${id}'`), 'Please confirm the date of the service');
    assert.ok(!failed(as('M', `select public.update_my_funeral_submission('${id}', '{"announcement":"Peacefully at home."}'::jsonb)`)));
    assert.equal(status(id), 'submitted');
    assert.equal(asScalar('A', `select count(*) from public.my_funeral_submissions() where id='${id}'`), '0', 'nobody else sees my submissions');
    assert.match(as('A', `select public.update_my_funeral_submission('${id}', '{"announcement":"hijack"}'::jsonb)`), /Unknown notice/);
    approve(id);
    assert.match(as('M', `select public.update_my_funeral_submission('${id}', '{"announcement":"after publication"}'::jsonb)`), /ask for a correction/);
  });
  test('11 the submitter can withdraw at once (removed immediately); another member cannot; the withdrawal is audited', () => {
    const id = approve(submit('D', { full_name: 'To Withdraw' }));
    assert.ok(pub().includes(id));
    assert.match(as('A', `select public.withdraw_my_funeral_notice('${id}')`), /Unknown notice/);
    assert.ok(!failed(as('D', `select public.withdraw_my_funeral_notice('${id}')`)));
    assert.equal(status(id), 'withdrawn'); assert.ok(!pub().includes(id));
    assert.equal(auditCount('funeral_taken_down', id), 1);
    assert.match(as('D', `select public.withdraw_my_funeral_notice('${id}')`), /Unknown notice/, 'cannot be withdrawn twice');
  });
  test('12 staff takedown is immediate and audited; only staff can do it; only a published notice can be taken down', () => {
    const id = approve(submit('P', { full_name: 'To Take Down' }));
    for (const who of ['P', 'A', 'anon'] as const) assert.match(as(who, `select public.admin_funeral_takedown('${id}','x')`), /Staff only|permission denied/, who);
    assert.ok(!failed(as('O', `select public.admin_funeral_takedown('${id}','Family asked by phone')`)));
    assert.equal(status(id), 'taken_down'); assert.ok(!pub().includes(id));
    assert.match(as('O', `select public.admin_funeral_takedown('${id}','again')`), /Unknown published notice/);
    assert.equal(auditCount('funeral_taken_down', id), 1);
    assert.match(as('A', `select * from public.admin_funeral_queue()`), /Staff only/);
    assert.ok(Number(asScalar('O', `select count(*) from public.admin_funeral_queue()`)) > 5, 'staff see the queue (with private data)');
  });
  test('13 correction and takedown requests: sign-in required, rate limited, handled by staff only; a takedown request removes the notice, a correction request applies a partial fix', () => {
    const id = approve(submit('N', { full_name: 'Needs Correcting', announcement: 'Peacfully at home.' }));
    assert.match(as('anon', `select public.request_funeral_notice_change('${id}','correction','Spelling error in the announcement')`), /permission denied|Sign in/);
    assert.match(as('A', `select public.request_funeral_notice_change('${id}','bogus','whatever message')`), /Unknown request/);
    assert.match(as('A', `select public.request_funeral_notice_change(gen_random_uuid(),'correction','whatever message')`), /Unknown notice/);
    const x = approve(submit('C', { full_name: 'Rate Limit Target' }));
    const corr = idOf(as('A', `select public.request_funeral_notice_change('${id}','correction','Spelling error in the announcement','a@example.org')`));
    const tdn = idOf(as('A', `select public.request_funeral_notice_change('${id}','takedown','The family have asked for this to be removed')`));
    for (let i = 0; i < 3; i++) assert.ok(!failed(as('A', `select public.request_funeral_notice_change('${x}','correction','another request number ${i}')`)));
    assert.match(as('A', `select public.request_funeral_notice_change('${x}','correction','one request too many')`), /Too many requests/);
    assert.match(as('A', `select * from public.admin_funeral_change_requests()`), /Staff only/);
    assert.equal(asScalar('O', `select count(*) from public.admin_funeral_change_requests() where funeral_id = '${id}'`), '2');
    assert.ok(!failed(as('O', `select public.admin_funeral_resolve_change('${corr}','actioned','Fixed','{"announcement":"Peacefully at home."}'::jsonb)`)));
    assert.equal(scalar(`select announcement from funeral_notices where id='${id}'`), 'Peacefully at home.');
    assert.ok(pub().includes(id), 'a correction keeps the notice published');
    assert.equal(auditCount('funeral_corrected', id), 1);
    assert.ok(!failed(as('O', `select public.admin_funeral_resolve_change('${tdn}','actioned','Removed at the request of the family')`)));
    assert.equal(status(id), 'taken_down'); assert.ok(!pub().includes(id));
    assert.match(as('O', `select public.admin_funeral_resolve_change('${tdn}','actioned')`), /Unknown open request/, 'a request is handled once');
  });
  test('14 the audit trail records submission, review, publication, correction and takedown with the actor, and it cannot be altered', () => {
    for (const e of ['funeral_submitted', 'funeral_reviewed', 'funeral_published', 'funeral_corrected', 'funeral_taken_down', 'funeral_change_requested']) {
      assert.ok(Number(scalar(`select count(*) from notice_audit_log where event='${e}' and funeral_id is not null and actor_id is not null`)) >= 1, e);
    }
    assert.match(file(`delete from notice_audit_log where funeral_id is not null`), /append-only/);
  });
});

describe('notifications (selection only): what the family approved, to those who opted in, once', () => {
  let A_ = '', B_ = '';
  before(() => {
    file(`delete from notice_notification_prefs`);
    file(`insert into notice_notification_prefs (user_id, funeral_notices) values ('${M1}', true), ('${M2}', true), ('${M3}', false)`);
    file(`insert into notice_notification_prefs (user_id, essential_alerts) values ('${U.A}', true)`);
    file(`insert into member_areas (user_id, area_id) values ('${M1}','${AREA}'), ('${M2}','${AREA2}'), ('${M3}','${AREA}'), ('${U.A}','${AREA}')`);
    A_ = approve(submit('O', { full_name: 'Notify Allowed', area_id: AREA, announce_in_notifications: true }));
    B_ = approve(submit('S', { full_name: 'Notify Not Allowed', area_id: AREA, announce_in_notifications: false }));
  });
  const recips = (id: string) => raw(`select user_id from public.funeral_dispatch_recipients('${id}')`).split('\n').filter((l) => /^[0-9a-f-]{36}$/.test(l.trim())).map((l) => l.trim()).sort();
  test('15 the notification text is discreet by default (no name) and names the person only when the family said so', () => {
    assert.equal(scalar(`select title || ' | ' || body from public.funeral_notification_text('${A_}')`).includes('Notify Allowed'), false);
    assert.match(scalar(`select body from public.funeral_notification_text('${A_}')`), /^A notice has been published for the .* area\.$/);
    file(`update funeral_notices set announce_name_in_preview = true where id='${A_}'`);
    assert.match(scalar(`select body from public.funeral_notification_text('${A_}')`), /Notify Allowed/);
    file(`update funeral_notices set announce_name_in_preview = false where id='${A_}'`);
  });
  test('16 only family-approved, published notices are dispatchable; the audience is members who opted in to FUNERAL announcements and follow the area (essential opt-in is not enough)', () => {
    assert.match(scalar(`select public.funeral_dispatchable('${B_}')`), /family has not approved/);
    assert.equal(scalar(`select coalesce(public.funeral_dispatchable('${A_}'),'OK')`), 'OK');
    assert.deepEqual(recips(A_), [M1], 'M1: opted in + follows the area. M2: opted in, other area. M3: not opted in. A: essential only');
    assert.deepEqual(recips(B_), []);
    const wide = approve(submit('O', { full_name: 'Area-less notice', announce_in_notifications: true }));
    assert.deepEqual(recips(wide), [M1, M2].sort(), 'no area on the notice = every opted-in member');
  });
  test('17 one announcement per notice: claim, deliver, complete, then never again — a correction does not re-announce; takedown before or during a run stops it', () => {
    const d = idOf(as('service', `select public.funeral_claim_dispatch('${A_}')`)); assert.match(d, /^[0-9a-f-]{36}$/);
    assert.match(as('service', `select public.funeral_claim_dispatch('${A_}')`), /already in progress/);
    as('service', `select public.funeral_record_delivery('${A_}','${M1}','sent')`);
    assert.deepEqual(recips(A_), [], 'a delivered member is not selected again');
    as('service', `select public.notice_complete_dispatch('${d}')`);
    assert.match(as('service', `select public.funeral_claim_dispatch('${A_}')`), /Already announced/);
    file(`update funeral_notices set announcement = 'Corrected wording.' where id='${A_}'`);
    assert.match(as('service', `select public.funeral_claim_dispatch('${A_}')`), /Already announced/);
    const mid = approve(submit('A', { full_name: 'Taken Down Mid Run', announce_in_notifications: true }));
    assert.ok(recips(mid).length > 0);
    as('O', `select public.admin_funeral_takedown('${mid}','withdrawn by family')`);
    assert.deepEqual(recips(mid), []); assert.match(as('service', `select public.funeral_claim_dispatch('${mid}')`), /not published/);
  });
  test('18 no client can call the dispatch functions; funeral deliveries never touch the imports guard; deleting the submitter\'s account does not remove a published notice', () => {
    for (const who of ['A', 'S', 'O', 'anon'] as const) for (const fn of [`funeral_dispatch_recipients('${A_}')`, `funeral_claim_dispatch('${A_}')`, `funeral_dispatchable('${A_}')`, `funeral_notification_text('${A_}')`]) {
      assert.match(as(who, `select * from public.${fn}`), /permission denied/, `${who} ${fn}`);
    }
    assert.equal(as('service', `select public.can_dispatch_funeral('${U.O}')`).includes('t'), true, 'a moderator may announce');
    assert.equal(as('service', `select public.can_dispatch_funeral('${U.S}')`).includes('t'), true, 'an administrator may announce');
    assert.equal(as('service', `select public.can_dispatch_funeral('${U.A}')`).split('\n').pop()!.trim(), 'f', 'an ordinary member may not');
    assert.match(as('A', `select public.can_dispatch_funeral('${U.A}')`), /permission denied/);
    const id = approve(submit('M', { full_name: 'Survives Account Deletion' }));
    file(`delete from hub_members where user_id='${U.M}'`);
    const del = file(`delete from profiles where id='${U.M}'`); assert.ok(!failed(del), del);
    assert.ok(pub().includes(id), 'the published notice remains');
    assert.equal(scalar(`select (submitter_id is null)::text from funeral_notices where id='${id}'`), 'true');
  });
});
