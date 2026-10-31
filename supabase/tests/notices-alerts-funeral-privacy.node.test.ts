/**
 * notices-alerts-funeral-privacy.node.test.ts — funeral privacy, account-deletion cleanup, memberships, retention, no-account enquiries and audit redaction,
 * proven in an ISOLATED Postgres against the real migrations.
 *
 * PROVES: deleting an account removes the submitter's private details from every funeral state while an approved announcement stays public and unchanged;
 * the minimum restricted evidence of authority stays; other families' submissions are untouched; the cleanup is service-role-only, atomic, idempotent and
 * recoverable; organisation memberships are deactivated (publisher, delegate, funeral director) without touching the organisation or anyone else, and a closed
 * account has no authority even before cleanup and cannot be given any; moderation notes cannot carry telephone numbers / email addresses; a signed-out
 * person can ask for a correction or takedown, nothing changes until staff verify independently, and abuse is rate-limited; retention is dry-run first, gated,
 * boundary-exact and never touches a public, held or disputed record; audit redaction is administrator-only, reasoned, chronology-preserving and itself audited.
 * ALL identities are fictional. SAFETY — ISOLATED DATABASE ONLY; nothing is sent.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildDatabase, U, as, raw, file, scalar, failed, idOf, uuid } from './_support/notices-alerts-harness.ts';

type R = Parameters<typeof as>[0];
const q = (s: string) => s.replace(/'/g, "''");
const base = (o: Record<string, unknown> = {}) => JSON.stringify({ full_name: 'Mairi Testfixture', announcement: 'Much loved by all who knew her.', family_requests: 'Family flowers only', submitter_name: 'Jo Testfixture', submitter_relationship: 'Daughter', submitter_phone: '01595 000000', submitter_email: 'jo@family.example', family_authorised: true, ...o });
const submit = (who: R, o: Record<string, unknown> = {}) => { const out = as(who, `select public.submit_funeral_notice('${q(base(o))}'::jsonb)`); assert.ok(!failed(out), out); const id = idOf(out); file(`update funeral_notices set created_at = created_at - interval '3 days' where id='${id}'`); return id; };   // back-dated so the 3-per-day submission limit does not throttle fixtures
const review = (who: R, id: string, action: string, note: string | null = null, method: string | null = null, outcome: string | null = null, follow: string | null = null, code: string | null = null) => {
  const a = (v: string | null) => (v === null ? 'null' : `'${q(v)}'`);
  return as(who, `select public.admin_funeral_review('${id}','${action}', ${a(note)}, ${a(method)}, ${a(outcome)}, ${a(follow)}, ${a(code)})`);
};
const approve = (id: string) => { const r = review('O', id, 'approve', 'Confirmed with the funeral director', 'funeral_director_confirmation', 'confirmed'); assert.ok(!failed(r), r); return id; };
const status = (id: string) => scalar(`select status from funeral_notices where id='${id}'`);
const col = (id: string, c: string) => scalar(`select coalesce(${c}::text, 'NULL') from funeral_notices where id='${id}'`);
const svc = (sql: string) => as('service', sql);
const pub = () => as('anon', `select id from public.get_funeral_notices(null, 100, 0)`).split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f-]{36}$/.test(l));
const asUid = (uid: string, sql: string) => raw(`set role authenticated; select set_config('request.jwt.claim.sub','${uid}',false); ${sql}; reset role;`);
const audit = (event: string, id?: string) => Number(scalar(`select count(*) from notice_audit_log where event='${event}'${id ? ` and funeral_id='${id}'` : ''}`));
const profile = (id: string, role = 'customer') => file(`insert into profiles (id, role, display_name) values ('${id}','${role}','Fictional ${id.slice(0, 4)}') on conflict do nothing`);
const close = (id: string) => file(`update profiles set deleted_at = now(), is_active = false where id = '${id}'`);

before(() => { buildDatabase(); });

describe('account deletion: funeral submissions in every lifecycle state', () => {
  let ids: Record<string, string> = {};
  let other = '', otherPending = '', result = '';
  before(() => {
    ids.submitted = submit('A'); ids.review = submit('A'); review('O', ids.review, 'start_review');
    ids.needs = submit('A'); review('O', ids.needs, 'request_info', 'Please confirm the service date', null, null, 'awaiting_family_reply');
    ids.approved = approve(submit('A', { service_public: true, service_kind: 'funeral', service_venue: 'Fictional Kirk' }));
    ids.withdrawn = submit('A'); assert.ok(!failed(as('A', `select public.withdraw_my_funeral_notice('${ids.withdrawn}')`)));
    ids.rejected = submit('A'); review('O', ids.rejected, 'reject', 'Could not verify', null, 'unable_to_contact', 'none', 'unverifiable');
    ids.takendown = approve(submit('A')); assert.ok(!failed(as('O', `select public.admin_funeral_takedown('${ids.takendown}','Family asked')`)));
    other = approve(submit('A2', { full_name: 'Bystander Fixture', submitter_name: 'Kit Fixture', submitter_phone: '01595 111111' })); otherPending = submit('A2');
    result = svc(`select public.delete_member_funeral_data('${U.A}')`);
  });
  test('1 the cleanup reports what it did per state and is service-role only', () => {
    assert.match(result, /"funeral_notices"/);
    for (const who of ['anon', 'A', 'A2', 'O', 'S'] as const) assert.match(as(who, `select public.delete_member_funeral_data('${U.A}')`), /permission denied|Staff|ERROR/, who);
    for (const who of ['anon', 'A', 'O', 'S'] as const) assert.match(as(who, `select public.delete_member_memberships('${U.A}')`), /permission denied/, who);
  });
  test('2 private submitter details are gone from EVERY state, and the account link with them', () => {
    for (const [name, id] of Object.entries(ids)) {
      assert.equal(scalar(`select (submitter_id is null and submitter_name is null and submitter_phone is null and submitter_email is null and submitter_relationship is null and review_message is null and review_note is null and scrubbed_at is not null)::text from funeral_notices where id='${id}'`), 'true', name);
    }
  });
  test('3 an APPROVED announcement is preserved exactly: still public, same content, same display period, deletion scheduled 90 days after display ends', () => {
    assert.equal(status(ids.approved), 'approved');
    assert.ok(pub().includes(ids.approved));
    assert.equal(col(ids.approved, 'announcement'), 'Much loved by all who knew her.');
    assert.equal(col(ids.approved, 'service_venue'), 'Fictional Kirk');
    assert.equal(scalar(`select (retain_until = display_until + interval '90 days')::text from funeral_notices where id='${ids.approved}'`), 'true');
    const shown = as('anon', `select * from public.get_funeral_notice('${ids.approved}')`);
    for (const secret of ['Jo Testfixture', '01595', 'jo@family.example', 'Daughter']) assert.ok(!shown.includes(secret), `public read leaks ${secret}`);
  });
  test('4 PENDING (submitted / in review / needs information) cannot be verified without the family, so it is withdrawn (never public), reduced to the minimum and scheduled for deletion in 30 days', () => {
    for (const k of ['submitted', 'review', 'needs']) {
      const id = ids[k];
      assert.equal(status(id), 'withdrawn', k); assert.ok(!pub().includes(id));
      assert.equal(col(id, 'announcement'), 'NULL'); assert.equal(col(id, 'family_requests'), 'NULL');
      assert.equal(col(id, 'full_name'), 'Mairi Testfixture', 'the minimum needed to deal with a dispute');
      assert.equal(scalar(`select (retain_until between now() + interval '29 days' and now() + interval '31 days')::text from funeral_notices where id='${id}'`), 'true', k);
    }
  });
  test('5 WITHDRAWN keeps the minimum; REJECTED and TAKEN-DOWN become a moderation stub (no name, no content) kept 90 days', () => {
    assert.equal(col(ids.withdrawn, 'announcement'), 'NULL'); assert.equal(col(ids.withdrawn, 'full_name'), 'Mairi Testfixture');
    for (const k of ['rejected', 'takendown']) {
      const id = ids[k];
      assert.equal(col(id, 'full_name'), '[removed]', k); assert.equal(col(id, 'announcement'), 'NULL', k); assert.equal(col(id, 'died_on'), 'NULL', k);
      assert.equal(scalar(`select (retain_until between now() + interval '89 days' and now() + interval '91 days')::text from funeral_notices where id='${id}'`), 'true', k);
    }
    assert.equal(col(ids.rejected, 'rejection_code'), 'unverifiable'); assert.equal(status(ids.rejected), 'rejected'); assert.equal(status(ids.takendown), 'taken_down');
  });
  test('6 the minimum restricted evidence of authority REMAINS: who verified, how, the outcome, when, the role and the funeral director', () => {
    assert.equal(scalar(`select (verification_method = 'funeral_director_confirmation' and verification_outcome = 'confirmed' and verified_by is not null and verified_at is not null and family_authorised and submitter_role = 'family')::text from funeral_notices where id='${ids.approved}'`), 'true');
    for (const who of ['anon', 'A', 'A2', 'S', 'O'] as const) assert.match(as(who, `select verification_method from funeral_notices where id='${ids.approved}'`), /permission denied/, `${who} cannot read the evidence directly`);
  });
  test('7 another family\'s submissions are untouched', () => {
    assert.equal(col(other, 'submitter_name'), 'Kit Fixture'); assert.equal(col(other, 'submitter_phone'), '01595 111111'); assert.equal(status(other), 'approved');
    assert.equal(status(otherPending), 'submitted'); assert.equal(col(otherPending, 'scrubbed_at'), 'NULL');
  });
  test('8 every cleanup is recorded in the audit log with no personal data, and a repeat does nothing', () => {
    assert.equal(audit('funeral_submitter_scrubbed'), Object.keys(ids).length);
    assert.equal(scalar(`select count(*) from notice_audit_log where event='funeral_submitter_scrubbed' and details::text ~* '(Testfixture|01595|jo@family)'`), '0');
    const again = svc(`select public.delete_member_funeral_data('${U.A}')`);
    assert.match(again, /"funeral_notices": \{\}/); assert.equal(audit('funeral_submitter_scrubbed'), Object.keys(ids).length);
  });
  test('9 a failure part-way leaves NOTHING half-done and a retry succeeds (atomic, recoverable)', () => {
    const a = submit('A3', { full_name: 'Recovery One' }), b = submit('A3', { full_name: 'Recovery Two' });
    raw(`create function public.tg_test_boom() returns trigger language plpgsql as $$ begin if new.id = '${b}' and new.scrubbed_at is not null then raise exception 'simulated failure'; end if; return new; end $$;
         create trigger test_boom before update on public.funeral_notices for each row execute function public.tg_test_boom();`);
    assert.match(svc(`select public.delete_member_funeral_data('${U.A3}')`), /simulated failure/);
    for (const id of [a, b]) assert.equal(col(id, 'submitter_name'), 'Jo Testfixture', 'rolled back');
    assert.equal(audit('funeral_submitter_scrubbed', a), 0);
    raw(`drop trigger test_boom on public.funeral_notices; drop function public.tg_test_boom();`);
    assert.ok(!failed(svc(`select public.delete_member_funeral_data('${U.A3}')`)));
    for (const id of [a, b]) assert.equal(col(id, 'submitter_name'), 'NULL');
  });
  test('10 an unknown member is refused (the function does not guess)', () => {
    assert.match(svc(`select public.delete_member_funeral_data('${uuid()}')`), /Unknown member/);
  });
});

describe('account deletion: organisation memberships', () => {
  let COUNCIL = '', NHS = '';
  const P2 = uuid(), ADM2 = uuid(), MOD2 = uuid();
  before(() => {
    COUNCIL = idOf(as('S', `select public.admin_upsert_official_publisher('shetland-islands-council','Shetland Islands Council','council')`));
    NHS = idOf(as('S', `select public.admin_upsert_official_publisher('nhs-shetland','NHS Shetland','health')`));
    for (const o of [COUNCIL, NHS]) as('S', `select public.admin_verify_official_publisher('${o}','Verified by call-back to the published number')`);
    profile(P2); profile(ADM2, 'admin'); profile(MOD2, 'moderator');
    as('S', `select public.admin_set_official_publisher_member('${COUNCIL}','${U.P}','publisher')`);
    as('S', `select public.admin_set_official_publisher_member('${COUNCIL}','${U.D}','delegate')`);
    as('S', `select public.admin_set_official_publisher_member('${COUNCIL}','${P2}','publisher')`);
    as('S', `select public.admin_set_official_publisher_member('${NHS}','${U.N}','publisher')`);
    as('S', `select public.admin_grant_essential_alert('${COUNCIL}','Approved first Essential Alert publisher')`);
    as('S', `select public.admin_set_funeral_director('Fictional Funeral Directors','${U.F}')`);
  });
  const authority = (uid: string, org: string) => last(asUid(uid, `select public.official_publisher_authority('${org}')`));
  const last = (o: string) => o.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  test('1 before deletion the publisher and the delegate hold their authority', () => {
    assert.equal(authority(U.P, COUNCIL), 'essential'); assert.equal(authority(U.D, COUNCIL), 'official');
  });
  test('2 a PUBLISHER account deleted: membership deactivated, organisation and every other member untouched', () => {
    close(U.P);
    assert.equal(authority(U.P, COUNCIL), 'none', 'closed accounts have no authority even before cleanup (the token is still valid)');
    assert.match(svc(`select public.delete_member_memberships('${U.P}')`), /"official_publisher_members": 1/);
    assert.equal(scalar(`select (not is_active and removed_at is not null)::text from official_publisher_members where publisher_id='${COUNCIL}' and user_id='${U.P}'`), 'true');
    assert.equal(authority(P2, COUNCIL), 'essential'); assert.equal(authority(U.D, COUNCIL), 'official'); assert.equal(authority(U.N, NHS), 'official');
    assert.equal(scalar(`select (is_active and verified_at is not null)::text from official_publishers where id='${COUNCIL}'`), 'true');
  });
  test('3 a DELEGATE account deleted is deactivated separately, with no effect on the organisation\'s publisher', () => {
    close(U.D); svc(`select public.delete_member_memberships('${U.D}')`);
    assert.equal(authority(U.D, COUNCIL), 'none'); assert.equal(authority(P2, COUNCIL), 'essential');
  });
  test('4 a deleted account cannot regain authority: re-adding it, or reactivating the seat, is refused', () => {
    assert.match(as('S', `select public.admin_set_official_publisher_member('${COUNCIL}','${U.P}','publisher')`), /closed/);
    assert.match(as('S', `select public.admin_set_funeral_director('Fictional Funeral Directors','${U.P}')`), /closed/);
    assert.equal(authority(U.P, COUNCIL), 'none');
  });
  test('5 a FUNERAL DIRECTOR account deleted loses the director seat; the firm and other directors remain', () => {
    const F2 = uuid(); profile(F2);
    as('S', `select public.admin_set_funeral_director('Fictional Funeral Directors','${F2}')`);
    close(U.F);
    assert.match(as('F', `select public.submit_funeral_notice('${q(base({ submitter_role: 'funeral_director' }))}'::jsonb)`), /Sign in|not an authorised/, 'closed account cannot submit as a director before cleanup');
    assert.match(svc(`select public.delete_member_memberships('${U.F}')`), /"funeral_director_members": 1/);
    assert.equal(scalar(`select (not is_active)::text from funeral_director_members where user_id='${U.F}'`), 'true');
    assert.equal(scalar(`select (is_active)::text from funeral_director_members where user_id='${F2}'`), 'true');
    assert.equal(scalar(`select (is_active and verified_at is not null)::text from funeral_directors where business_name='Fictional Funeral Directors'`), 'true');
    assert.equal(asUid(F2, `select public.submit_funeral_notice('${q(base({ submitter_role: 'funeral_director' }))}'::jsonb)`).includes('ERROR'), false);
  });
  test('6 a deleted ADMINISTRATOR and a deleted MODERATOR lose their authority at once (role is not enough)', () => {
    assert.ok(!failed(asUid(ADM2, `select public.admin_upsert_official_publisher('adm2-org','Adm2 Org','other')`)));
    assert.match(asUid(MOD2, `select * from public.admin_funeral_queue(null)`), /^(?!.*Staff only)/s);
    close(ADM2); close(MOD2);
    assert.match(asUid(ADM2, `select public.admin_upsert_official_publisher('adm2-org-b','Adm2 Org B','other')`), /Platform administrators only/);
    assert.match(asUid(MOD2, `select * from public.admin_funeral_queue(null)`), /Staff only/);
    assert.match(asUid(ADM2, `select * from public.admin_funeral_queue(null)`), /Staff only/);
  });
  test('7 cleanup is idempotent, audited without personal data, and records only the kind and role', () => {
    assert.match(svc(`select public.delete_member_memberships('${U.P}')`), /"official_publisher_members": 0/);
    assert.equal(audit('member_memberships_deactivated') >= 3, true);
    assert.equal(scalar(`select count(*) from notice_audit_log where event='member_memberships_deactivated' and details::text ~ '${U.P}'`), '0');
  });
});

describe('moderation: structured record and note guard', () => {
  test('1 approve records method, outcome, date and reviewer in STRUCTURED fields; a note is optional', () => {
    const id = submit('A2');
    const r = review('O', id, 'approve', null, 'phone_callback', 'confirmed', 'none'); assert.ok(!failed(r), r);
    assert.equal(scalar(`select (verification_method='phone_callback' and verification_outcome='confirmed' and verified_at is not null and verified_by is not null and verification_note is null and followup_action='none')::text from funeral_notices where id='${id}'`), 'true');
  });
  test('2 an outcome other than confirmed cannot approve; follow-up and rejection codes are constrained', () => {
    const id = submit('A2');
    assert.match(review('O', id, 'approve', null, 'phone_callback', 'unable_to_contact'), /confirmed/);
    assert.match(review('O', id, 'request_info', 'Ring back tomorrow', null, null, 'whenever'), /Unknown follow-up/);
    assert.match(review('O', id, 'reject', 'No', null, null, null, 'because'), /Unknown rejection reason|violates/);
    assert.ok(!failed(review('O', id, 'request_info', 'Ring back tomorrow', null, null, 'callback_later')));
    assert.equal(col(id, 'followup_action'), 'callback_later');
  });
  test('3 a note cannot hold a telephone number or an email address (the evidence lives in the structured fields, the family\'s details in the restricted record)', () => {
    const id = submit('A2');
    assert.match(review('O', id, 'approve', 'Rang her on 01595 123456', 'phone_callback', 'confirmed'), /telephone numbers or email/);
    assert.match(review('O', id, 'approve', 'Emailed jo@family.example', 'phone_callback', 'confirmed'), /telephone numbers or email/);
    assert.match(review('O', id, 'reject', 'call +44 1595 123456', null, null, null, 'other'), /telephone numbers or email/);
    assert.match(as('O', `select public.admin_funeral_takedown('${id}','ring 01595 123456')`), /telephone numbers or email/);
    assert.equal(status(id), 'submitted');
    assert.ok(!failed(review('O', id, 'approve', 'Confirmed by the firm on the day (reference 2026-17)', 'funeral_director_confirmation', 'confirmed')));
  });
  test('4 a closed staff account cannot moderate; staff-only is unchanged for everyone else', () => {
    const id = submit('A2');
    for (const who of ['anon', 'A', 'A2', 'F'] as const) assert.match(review(who, id, 'approve', null, 'phone_callback', 'confirmed'), /Staff only|permission denied/, who);
  });
});

describe('no-account correction / takedown / enquiry', () => {
  let live = '', hidden = '';
  before(() => { live = approve(submit('A')); hidden = submit('A'); });
  const enquire = (id: string, kind = 'takedown', msg = 'Please remove this notice', contact = 'rel@family.example', name = 'R Relative', rel = 'Son') =>
    as('service', `select public.submit_funeral_enquiry('${id}','${kind}','${q(msg)}','${q(contact)}','${q(name)}','${q(rel)}')`);   // the Edge Function's identity
  test('1 ONLY the trusted server-side caller can file an enquiry: anon, signed-in members, staff and administrators are refused (the PostgREST bypass is closed); nothing changes by itself', () => {
    for (const who of ['anon', 'A', 'O', 'S'] as const) assert.match(as(who, `select public.submit_funeral_enquiry('${live}','takedown','Please remove this notice','x@family.example')`), /permission denied/, who);
    assert.equal(scalar(`select count(*) from funeral_change_requests where funeral_id='${live}'`), '0', 'the refused calls filed nothing');
    const out = enquire(live); assert.ok(!failed(out), out);
    assert.equal(status(live), 'approved'); assert.ok(pub().includes(live));
    assert.equal(scalar(`select (source='public' and requester_id is null and status='open')::text from funeral_change_requests where id='${idOf(out)}'`), 'true');
    assert.equal(audit('funeral_enquiry_received', live), 1);
  });
  test('2 an unpublished or unknown notice gets the SAME answer (this cannot be used to probe for submissions)', () => {
    assert.match(enquire(hidden), /Unknown notice/); assert.match(enquire(uuid()), /Unknown notice/);
  });
  test('3 validation: kind, message, a way to reply', () => {
    assert.match(enquire(live, 'delete'), /Unknown request/); assert.match(enquire(live, 'takedown', 'no'), /what you need/); assert.match(enquire(live, 'takedown', 'Please remove', ''), /telephone number or email/);
  });
  test('4 database BACKSTOPS (the per-client allowances are enforced before this call, by the Edge Function): the same contact is limited, but one announcement or the whole site is no longer lockable by a handful of calls', () => {
    const id = approve(submit('A2', { full_name: 'Backstop Limited' }));
    for (let i = 0; i < 8; i++) assert.ok(!failed(enquire(id, 'enquiry', `Question number ${i}`, `person${i}@example.test`)), `request ${i}: 3 per announcement is no longer a shared quota`);
    for (const c of ['same@example.test', 'SAME@example.test', 'Same@Example.test']) assert.ok(!failed(enquire(id, 'enquiry', 'Same person asking', c)));
    assert.match(enquire(id, 'enquiry', 'Same person asking again', 'SAME@example.test'), /Too many requests/, 'one contact: 3 a day');
    // the announcement backstop is 30 a day (reached only by a flood that already beat every per-client allowance)
    const flood = approve(submit('A2', { full_name: 'Flooded' }));
    file(`insert into funeral_change_requests (funeral_id, kind, source, contact, message) select '${flood}', 'enquiry', 'public', 'bot' || g || '@x.test', 'flood message ' || g from generate_series(1, 30) g`);
    assert.match(enquire(flood, 'enquiry', 'A genuine family request', 'family@real.test'), /Too many requests/, 'backstop: 30 per announcement per day');
    const other = approve(submit('A2', { full_name: 'Unrelated Family' }));
    assert.ok(!failed(enquire(other, 'enquiry', 'A genuine family request elsewhere', 'family2@real.test')), 'a flooded announcement does not stop an unrelated one');
  });
  test('5 the request is private: no client can read it; staff see it in the queue', () => {
    for (const who of ['anon', 'A', 'A2', 'F'] as const) assert.match(as(who, `select * from public.admin_funeral_change_requests()`), /Staff only|permission denied/, who);
    assert.match(as('O', `select * from public.admin_funeral_change_requests()`), /rel@family\.example/);
    for (const who of ['anon', 'A'] as const) assert.match(as(who, `select * from funeral_change_requests`), /permission denied/);
  });
  test('6 staff cannot act on a no-account request until they record HOW authority was verified independently', () => {
    const req = scalar(`select id from funeral_change_requests where funeral_id='${live}' and source='public' order by created_at limit 1`);
    assert.match(as('O', `select public.admin_funeral_resolve_change('${req}','actioned','Removing')`), /Verify the requester independently/);
    assert.match(as('O', `select public.admin_funeral_resolve_change('${req}','actioned','Removing', null, 'not_verified')`), /Verify the requester independently/);
    assert.match(as('O', `select public.admin_funeral_resolve_change('${req}','actioned','Called 01595 123456', null, 'independent_contact')`), /telephone numbers or email/);
    assert.equal(status(live), 'approved');
    assert.match(as('A', `select public.admin_funeral_resolve_change('${req}','actioned','x', null, 'independent_contact')`), /Staff only|permission denied/);
    const ok = as('O', `select public.admin_funeral_resolve_change('${req}','actioned','Verified with the funeral director', null, 'funeral_director_confirmation')`);
    assert.ok(!failed(ok), ok);
    assert.equal(status(live), 'taken_down'); assert.ok(!pub().includes(live));
    assert.match(scalar(`select details::text from notice_audit_log where event='funeral_change_resolved' and details->>'request'='${req}'`), /funeral_director_confirmation/, 'the audit trail records HOW authority was verified');
    assert.equal(scalar(`select (status='actioned' and authority_check='funeral_director_confirmation' and contact is null and contact_name is null and handled_by is not null)::text from funeral_change_requests where id='${req}'`), 'true', 'the enquirer\'s details are removed once the outcome is recorded');
  });
  test('7 a verified correction applies only the fields staff supply; a declined request changes nothing', () => {
    const id = approve(submit('A', { full_name: 'Correct Me' }));
    const req = idOf(enquire(id, 'correction', 'The service time is wrong', 'c@example.test'));
    const ok = as('O', `select public.admin_funeral_resolve_change('${req}','actioned','Time corrected', '{"service_notes":"Service at 2pm"}'::jsonb, 'independent_contact')`); assert.ok(!failed(ok), ok);
    assert.equal(col(id, 'service_notes'), 'Service at 2pm'); assert.equal(status(id), 'approved');
    const req2 = idOf(enquire(id, 'takedown', 'Remove it please', 'd@example.test'));
    assert.ok(!failed(as('O', `select public.admin_funeral_resolve_change('${req2}','declined','Could not verify')`)));
    assert.equal(status(id), 'approved');
  });
  test('8 staff can log a request received by telephone; a non-staff user cannot', () => {
    const id = approve(submit('A', { full_name: 'Logged By Phone' }));
    assert.match(as('A', `select public.admin_log_funeral_enquiry('${id}','takedown','Caller asked for removal')`), /Staff only|permission denied/);
    const out = as('O', `select public.admin_log_funeral_enquiry('${id}','takedown','Caller asked for removal', null, 'Caller', 'Nephew')`); assert.ok(!failed(out), out);
    assert.equal(scalar(`select source from funeral_change_requests where id='${idOf(out)}'`), 'staff_logged');
    assert.match(as('O', `select public.admin_funeral_resolve_change('${idOf(out)}','actioned','x')`), /Verify the requester independently/);
  });
});

describe('retention: scheduled, dry-run first, gated', () => {
  let eligibleApproved = '', notYet = '', displayed = '', held = '', disputed = '', wd = '', wdFresh = '', rj = '';
  before(() => {
    const aged = (id: string, days: number) => file(`update funeral_notices set display_until = now() - interval '${days} days' where id='${id}'`);
    eligibleApproved = approve(submit('A', { full_name: 'Retention Eligible' })); aged(eligibleApproved, 91);
    notYet = approve(submit('A', { full_name: 'Retention Boundary' })); aged(notYet, 89);
    displayed = approve(submit('A', { full_name: 'Retention Displayed' }));
    held = approve(submit('A', { full_name: 'Retention Held' })); aged(held, 200);
    disputed = approve(submit('A', { full_name: 'Retention Disputed' }));
    assert.ok(!failed(as('service', `select public.submit_funeral_enquiry('${disputed}','enquiry','Open question about this notice','q@example.test')`)));   // raised while the notice was still displayed
    aged(disputed, 200);
    wd = submit('A', { full_name: 'Retention Withdrawn' }); as('A', `select public.withdraw_my_funeral_notice('${wd}')`); file(`update funeral_notices set retain_until = now() - interval '1 minute' where id='${wd}'`);
    wdFresh = submit('A', { full_name: 'Retention Fresh Withdrawn' }); as('A', `select public.withdraw_my_funeral_notice('${wdFresh}')`);
    rj = submit('A', { full_name: 'Retention Rejected' }); review('O', rj, 'reject', 'No', null, null, null, 'other'); file(`update funeral_notices set retain_until = now() - interval '1 minute' where id='${rj}'`);
    assert.ok(!failed(as('S', `select public.admin_set_funeral_retention_hold('${held}', true, 'Dispute reference 2026-04')`)));
  });
  const exists = (id: string) => scalar(`select count(*) from funeral_notices where id='${id}'`) === '1';
  test('1 retain_until follows the status: approved = display end + 90 days; withdrawn +30; rejected +90; pending none', () => {
    assert.equal(scalar(`select (retain_until = display_until + interval '90 days')::text from funeral_notices where id='${displayed}'`), 'true');
    assert.equal(scalar(`select (retain_until between now() + interval '29 days' and now() + interval '31 days')::text from funeral_notices where id='${wdFresh}'`), 'true');
    assert.equal(col(submit('A2'), 'retain_until'), 'NULL');
  });
  test('2 the report (administrators only, no personal data) separates eligible, not-yet and blocked records with reasons', () => {
    for (const who of ['anon', 'A', 'O', 'F'] as const) assert.match(as(who, `select * from public.admin_funeral_retention_report()`), /Platform administrators only|permission denied/, who);
    const rep = as('S', `select funeral_id, eligible, coalesce(blocked_by,'-') from public.admin_funeral_retention_report()`);
    assert.match(rep, new RegExp(`${eligibleApproved}\\|t\\|-`)); assert.match(rep, new RegExp(`${notYet}\\|f\\|-`));
    assert.match(rep, new RegExp(`${held}\\|f\\|retention_hold`)); assert.match(rep, new RegExp(`${disputed}\\|f\\|open_request`)); assert.match(rep, new RegExp(`${displayed}\\|f\\|still_displayed`));
    assert.ok(!/Retention|Testfixture/.test(rep), 'no names or content in the report');
  });
  test('3 a DRY RUN reports and changes nothing; the job is not callable by any client', () => {
    const out = svc(`select public.funeral_retention_run(true)`);
    assert.match(out, /"dry_run": true/); assert.match(out, /"deleted": 0/);
    for (const id of [eligibleApproved, notYet, held, disputed, wd, rj]) assert.ok(exists(id));
    for (const who of ['anon', 'A', 'O', 'S'] as const) assert.match(as(who, `select public.funeral_retention_run(true)`), /permission denied/, who);
    assert.ok(audit('funeral_retention_run') >= 1);
  });
  test('4 a REAL run is refused while the setting is off (the default), including to the service role', () => {
    assert.match(svc(`select public.funeral_retention_run(false)`), /not enabled/);
    for (const id of [eligibleApproved, wd, rj]) assert.ok(exists(id));
  });
  test('5 only an administrator, with a recorded reason, can switch it on', () => {
    for (const who of ['anon', 'A', 'O'] as const) assert.match(as(who, `select public.admin_set_funeral_retention_enabled(true, 'Release approval 2026-REL')`), /Platform administrators only|permission denied/, who);
    assert.match(as('S', `select public.admin_set_funeral_retention_enabled(true, 'ok')`), /Record why/);
    assert.ok(!failed(as('S', `select public.admin_set_funeral_retention_enabled(true, 'Release approval 2026-REL-TEST')`)));
  });
  test('6 an enabled run deletes ONLY what is eligible; a public, held, disputed or not-yet record is never touched; boundaries are exact', () => {
    const out = svc(`select public.funeral_retention_run(false)`); assert.match(out, /"dry_run": false/, out);
    for (const id of [eligibleApproved, wd, rj]) assert.ok(!exists(id), id);
    for (const id of [notYet, displayed, held, disputed, wdFresh]) assert.ok(exists(id), id);
    assert.ok(pub().includes(displayed));
  });
  test('7 a repeat run is idempotent, and the audit log (which has no content) survives', () => {
    assert.match(svc(`select public.funeral_retention_run(false)`), /"deleted": 0/);
    assert.ok(audit('funeral_retention_run') >= 3);
    assert.ok(Number(scalar(`select count(*) from notice_audit_log where funeral_id='${eligibleApproved}'`)) >= 1, 'history of the deleted notice remains');
  });
  test('8 removing the hold makes a record eligible; a hold needs a reason', () => {
    assert.match(as('S', `select public.admin_set_funeral_retention_hold('${held}', true, 'x')`), /Record why/);
    assert.ok(!failed(as('S', `select public.admin_set_funeral_retention_hold('${held}', false, null)`)));
    assert.match(svc(`select public.funeral_retention_run(true)`), new RegExp('"approved": 1'));
  });
});

describe('audit privacy: controlled, authorised, audited redaction', () => {
  let rid = 0, recent = 0;
  before(() => {
    file(`insert into notice_audit_log (at, actor_id, actor_role, event, funeral_id, details) values (now() - interval '400 days', '${U.O}', 'moderator', 'funeral_taken_down', '${uuid()}', '{"by":"staff","reason":"Phone 01595 123456 asked for removal"}')`);
    file(`insert into notice_audit_log (at, actor_id, actor_role, event, funeral_id, details) values (now() - interval '10 days', '${U.O}', 'moderator', 'funeral_taken_down', '${uuid()}', '{"by":"staff","reason":"Recent free text"}')`);
    rid = Number(scalar(`select id from notice_audit_log where details->>'reason' like 'Phone 01595%'`)); recent = Number(scalar(`select id from notice_audit_log where details->>'reason' = 'Recent free text'`));
  });
  test('1 the 12-month review list is administrator-only, shows ids and key names (never the text) and excludes recent entries', () => {
    for (const who of ['anon', 'A', 'O', 'F'] as const) assert.match(as(who, `select * from public.admin_audit_redaction_candidates()`), /Platform administrators only|permission denied/, who);
    const out = as('S', `select audit_id, keys from public.admin_audit_redaction_candidates()`);
    assert.match(out, new RegExp(`${rid}\\|\\{reason\\}`)); assert.ok(!out.includes(`${recent}|`)); assert.ok(!out.includes('01595'));
  });
  test('2 no ordinary access can alter the log: update and delete are refused for clients, and for anyone outside the redaction function', () => {
    for (const who of ['anon', 'A', 'O', 'S'] as const) assert.match(as(who, `update notice_audit_log set details='{}' where id=${rid}`), /permission denied/, who);
    assert.match(raw(`update notice_audit_log set details = '{"by":"staff","reason":"changed"}' where id=${rid}`), /append-only/);
    assert.match(raw(`delete from notice_audit_log where id=${rid}`), /append-only/);
    assert.match(raw(`select set_config('notices.audit_redaction','on',false); update notice_audit_log set event='funeral_published' where id=${rid}`), /append-only/, 'the flag alone does not permit changing anything but the marker');
    assert.match(raw(`select set_config('notices.audit_redaction','on',false); update notice_audit_log set details = '{"by":"staff","reason":"other words"}' where id=${rid}`), /append-only/);
  });
  test('3 only an administrator can redact, with a recorded reason, and only free-text entries', () => {
    for (const who of ['anon', 'A', 'O'] as const) assert.match(as(who, `select public.admin_redact_audit_text(${rid}, array['reason'], 'Request from the family')`), /Platform administrators only|permission denied/, who);
    assert.match(as('S', `select public.admin_redact_audit_text(${rid}, array['reason'], 'short')`), /Record why/);
    assert.match(as('S', `select public.admin_redact_audit_text(${rid}, array['by'], 'Request from the family')`), /free-text/);
    assert.match(as('S', `select public.admin_redact_audit_text(999999, array['reason'], 'Request from the family')`), /Unknown audit entry/);
  });
  test('4 redaction replaces the text with a marker and PRESERVES the event, time, actor, subject and every key', () => {
    const before = scalar(`select (event || at::text || actor_id::text || funeral_id::text) from notice_audit_log where id=${rid}`);
    assert.ok(!failed(as('S', `select public.admin_redact_audit_text(${rid}, array['reason'], 'Request from the family')`)));
    assert.equal(scalar(`select details::text from notice_audit_log where id=${rid}`), '{"by": "staff", "reason": "[redacted]"}');
    assert.equal(scalar(`select (event || at::text || actor_id::text || funeral_id::text) from notice_audit_log where id=${rid}`), before);
  });
  test('5 the redaction is itself audited and recorded in a ledger; a repeat does nothing', () => {
    assert.equal(scalar(`select count(*) from notice_audit_redactions where audit_id=${rid}`), '1');
    assert.equal(scalar(`select count(*) from notice_audit_log where event='audit_text_redacted' and details->>'audit_id' = '${rid}'`), '1');
    assert.match(as('S', `select reason from public.admin_audit_redactions()`), /Request from the family/);
    for (const who of ['anon', 'A', 'O'] as const) assert.match(as(who, `select * from public.admin_audit_redactions()`), /Platform administrators only|permission denied/, who);
    assert.ok(!failed(as('S', `select public.admin_redact_audit_text(${rid}, array['reason'], 'Request from the family')`)));
    assert.equal(scalar(`select count(*) from notice_audit_redactions where audit_id=${rid}`), '1');
    assert.ok(!as('S', `select audit_id from public.admin_audit_redaction_candidates()`).includes(`${rid}`));
  });
  test('6 the log stays append-only afterwards (the flag does not linger past the function)', () => {
    assert.match(raw(`update notice_audit_log set details = '{"by":"staff","reason":"again"}' where id=${rid}`), /append-only/);
  });
});

describe('closed accounts: a leftover token identifies nobody (every member, staff and organisation path)', () => {
  const MEM = uuid(), MODX = uuid();
  before(() => { profile(MEM); profile(MODX, 'moderator'); });
  const asId = (uid: string, sql: string) => asUid(uid, sql);
  test('1 a member whose account is closed (notices still present) cannot publish, edit or withdraw, and cannot read or write preferences and areas', () => {
    const out = asId(MEM, `select public.submit_person_notice('Closed account test','A fictional notice written before the account closed.','other', array[]::text[], null)`); assert.ok(!failed(out), out);
    const nid = idOf(out); close(MEM);
    assert.match(asId(MEM, `select public.submit_person_notice('After closing','A fictional notice written after the account closed.','other', array[]::text[], null)`), /Sign in/);
    assert.match(asId(MEM, `select public.edit_my_person_notice('${nid}','Edited','A fictional edit after the account closed.','other', array[]::text[], null)`), /ERROR/);
    assert.match(asId(MEM, `select public.withdraw_my_person_notice('${nid}')`), /ERROR/);
    assert.match(asId(MEM, `select public.my_notice_prefs()`), /Sign in/);
    assert.match(asId(MEM, `select public.set_my_notice_prefs(true)`), /ERROR/);
    assert.match(asId(MEM, `select public.set_my_notice_areas(array['shetland_wide'])`), /ERROR/);
    assert.equal(scalar(`select (select count(*) from member_areas where user_id='${MEM}') + (select count(*) from notice_notification_prefs where user_id='${MEM}')`), '0');
    assert.equal(asId(MEM, `select count(*) from public.member_areas where user_id = '${MEM}'`).split('\n').pop(), '0', 'the read policy returns nothing for a closed account');
  });
  test('2 a moderator whose account is closed cannot approve or decline a member notice or moderate funerals', () => {
    const author = uuid(); profile(author);
    const nid = idOf(asId(author, `select public.submit_person_notice('Needs approval','A fictional notice awaiting moderation here.','other', array[]::text[], null)`));
    assert.match(asId(MODX, `select public.staff_pending_person_notices()`), /^(?!.*Staff only)/s, 'while open, a moderator can');
    close(MODX);
    assert.match(asId(MODX, `select public.staff_approve_person_notice('${nid}')`), /Staff only/);
    assert.match(asId(MODX, `select public.staff_decline_person_notice('${nid}','No')`), /Staff only/);
    assert.match(asId(MODX, `select * from public.staff_pending_person_notices()`), /Staff only/);
    assert.equal(scalar(`select status from notices where id='${nid}'`), 'pending');
  });
});
