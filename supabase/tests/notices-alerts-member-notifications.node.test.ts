/**
 * notices-alerts-member-notifications.node.test.ts — moderator-controlled Community Notice notifications for members' personal notices, the DATABASE rules,
 * proven in an ISOLATED Postgres against the real migrations and the REAL should_notify() (copied verbatim from the notifications spine).
 *
 * PROVES: only STAFF may announce a member's notice; only a published, public, unexpired, started, un-hidden personal notice with an EXPLICIT place is
 * eligible; the audience = opted in + matching category + parent/child area (never siblings, never an unplaced notice; explicit Shetland-wide reaches members who
 * chose any area) + active account + valid device + master/notices switches on + not in quiet hours + under the 2-per-24-hours cap; the preview estimate IS that
 * audience; a quiet-hours hold is reported as such (not as a mute); the 24-hour cap holds under real concurrency; nothing in a preview names a person.
 * ALL identities are fictional. SAFETY — ISOLATED DATABASE ONLY; nothing is sent (the push sender is not part of this suite).
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildDatabase, U, as, raw, file, scalar, failed, idOf, uuid } from './_support/notices-alerts-harness.ts';

const pexec = promisify(execFile);
const DSN = process.env.PASS_PROOF_DSN ?? '', PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
const asUid = (uid: string, sql: string) => raw(`set role authenticated; select set_config('request.jwt.claim.sub','${uid}',false); ${sql}; reset role;`);
const q = (s: string) => s.replace(/'/g, "''");
let K = '', P = '', SIB = '', OTHER = '', OTHER_CAT = '';

const member = (opts: { areas?: string[]; community?: boolean; token?: string | null; cats?: string[] | null; prefs?: string } = {}) => {
  const id = uuid();
  file(`insert into profiles (id, role, display_name) values ('${id}','customer','Fictional ${id.slice(0, 4)}')`);
  if (opts.areas?.length) assert.ok(!failed(asUid(id, `select public.set_my_notice_areas(array[${opts.areas.map((a) => `'${a}'`).join(',')}])`)));
  if (opts.community !== false) assert.ok(!failed(asUid(id, `select public.set_my_notice_prefs(p_community => true${opts.cats ? `, p_categories => array[${opts.cats.map((c) => `'${c}'`).join(',')}]` : ''})`)));
  if (opts.token !== null) file(`insert into push_tokens (user_id, token) values ('${id}','${opts.token ?? `ExponentPushToken[${id.slice(0, 8)}]`}')`);
  if (opts.prefs) file(`insert into notification_preferences (user_id, enabled, notices_enabled, quiet_hours_start, quiet_hours_end) values ('${id}', ${opts.prefs})`);
  return id;
};
/** a member's published personal notice (author U.A) with the given areas; staff U.O approves; returns its id */
let seq = 0;
const published = (areas: string[], extra = '') => {
  const out = asUid(U.A, `select public.submit_person_notice('Fictional notice ${++seq}','A fictional notice written for the member notification tests.','other', array[${areas.map((a) => `'${a}'`).join(',')}]::text[], null)`);
  assert.ok(!failed(out), out); const id = idOf(out);
  file(`update notices set created_at = created_at - interval '3 days' where id='${id}'`);      // keep the author under the 5-pending limit
  assert.ok(!failed(asUid(U.O, `select public.staff_approve_person_notice('${id}')`)));
  if (extra) file(`update notices set ${extra} where id='${id}'`);
  return id;
};
const audience = (id: string) => new Set(raw(`select a from public.notice_member_audience('${id}') a`).split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f-]{36}$/.test(l)));
const recipientsOf = (id: string) => new Set(raw(`select user_id from public.notice_dispatch_recipients('${id}','member',5000)`).split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f-]{36}$/.test(l)));
const gate = (u: string) => scalar(`select public.notice_push_gate('${u}')`);
const nowWindow = (hoursBefore: number, hoursAfter: number) => `(now() at time zone 'Europe/London' - interval '${hoursBefore} hours')::time, (now() at time zone 'Europe/London' + interval '${hoursAfter} hours')::time`;

before(() => {
  buildDatabase();
  const kid = raw(`select a.id || ',' || a.parent_id from areas a join areas p on p.id = a.parent_id where p.type = 'locality' and a.is_active limit 1`).split(',');
  K = kid[0].trim(); P = kid[1].trim();
  const ids = raw(`select id from areas where type = 'locality' and is_active and id not in ('${K}','${P}') and coalesce(parent_id,'') <> '${P}' order by sort_order, id limit 2`).split('\n').map((s) => s.trim()).filter(Boolean);
  OTHER_CAT = raw(`select id from notice_categories where id <> 'other' order by id limit 1`).trim();
  SIB = raw(`select id from areas where parent_id = '${P}' and id <> '${K}' and is_active limit 1`).trim() || ids[0]; OTHER = ids[0];
});

describe('who may announce, and which notices are eligible', () => {
  test('1 STAFF ONLY: moderator, administrator and platform owner may; the author, other members, hub owners, organisation publishers and a CLOSED moderator may not', () => {
    const id = published([K]);
    const can = (u: string) => scalar(`select public.can_dispatch_notice('${u}','${id}','member')`);
    assert.equal(can(U.O), 't'); assert.equal(can(U.S), 't');
    for (const [who, u] of Object.entries({ author: U.A, member: U.A2, hubOwner: U.H, committee: U.C, council: U.P, delegate: U.D, funeralDirector: U.F, business: U.B })) assert.equal(can(u), 'f', who);
    const owner = uuid(); file(`insert into profiles (id, role, is_platform_owner, display_name) values ('${owner}','customer', true, 'Platform owner')`); assert.equal(can(owner), 't');
    const mod2 = uuid(); file(`insert into profiles (id, role, display_name) values ('${mod2}','moderator','Mod Two')`); assert.equal(can(mod2), 't');
    file(`update profiles set deleted_at = now(), is_active = false where id = '${mod2}'`); assert.equal(can(mod2), 'f', 'a closed account has no authority');
    assert.equal(scalar(`select public.can_dispatch_notice(null,'${id}','member')`), 'f');
    // a staff member still cannot announce a notice that is not a member's own
    assert.equal(scalar(`select public.can_dispatch_notice('${U.O}','${N_LEGACY_ID()}','member')`), 'f');
    for (const who of ['anon', 'A', 'O', 'S'] as const) assert.match(as(who, `select public.notice_dispatch_recipients('${id}','member')`), /permission denied/, `${who} cannot call the dispatch functions`);
  });
  test('2 eligibility: pending, declined/withdrawn, resolved, expired, hidden, not started, no place chosen, and non-member notices are refused; a placed published one is allowed', () => {
    const ok = published([K]); assert.equal(scalar(`select coalesce(public.notice_dispatchable('${ok}','member'),'ELIGIBLE')`), 'ELIGIBLE');
    const reason = (id: string) => scalar(`select public.notice_dispatchable('${id}','member')`);
    const pend = idOf(asUid(U.A, `select public.submit_person_notice('Pending one','A pending fictional notice for the tests here.','other', array['${K}']::text[], null)`)); file(`update notices set created_at = created_at - interval '3 days' where id='${pend}'`);
    assert.match(reason(pend), /not published/);
    const wd = published([K], `status = 'withdrawn'`); assert.match(reason(wd), /not published/);
    const res = published([K], `status = 'resolved'`); assert.match(reason(res), /not published/);
    const exp = published([K], `expires_at = now() - interval '1 minute'`); assert.match(reason(exp), /expired/);
    const hid = published([K], `is_hidden = true`); assert.match(reason(hid), /hidden/);
    const fut = published([K], `starts_at = now() + interval '1 day'`); assert.match(reason(fut), /not started/);
    const none = published([K]); file(`delete from notice_areas where notice_id='${none}'`); assert.match(reason(none), /no place chosen/);
    const members = published([K], `visibility = 'members'`); assert.match(reason(members), /not public/);
    assert.match(reason(N_LEGACY_ID()), /member/i, 'a hub notice is not a member notice');
    assert.equal(scalar(`select count(*) from public.notice_dispatch_recipients('${exp}','member')`), '0', 'no audience for an ineligible notice');
  });
});

describe('the audience (the same set the preview estimates and the dispatch sends to)', () => {
  test('3 AREA MATCHING: the exact area and its parent match; a sibling, an unrelated area and a member with no area do not; nothing is inferred', () => {
    const id = published([K]);
    const exact = member({ areas: [K] }), parent = member({ areas: [P] }), sibling = member({ areas: [SIB] }), other = member({ areas: [OTHER] }), none = member({ areas: [] });
    const a = audience(id);
    assert.ok(a.has(exact), 'follows the exact area'); assert.ok(a.has(parent), 'parent/child matching is preserved');
    assert.ok(!a.has(sibling), 'a sibling area is never matched'); assert.ok(!a.has(other)); assert.ok(!a.has(none), 'no area selected, no notification: nothing is inferred');
    const parentNotice = published([P]);
    assert.ok(audience(parentNotice).has(exact), 'a notice for the parent area reaches a member following a child'); assert.ok(!audience(parentNotice).has(other));
  });
  test('4 EXPLICIT Shetland-wide reaches members who chose ANY area; an unplaced notice reaches nobody; the two are distinct', () => {
    const wide = published(['shetland_wide']); const some = member({ areas: [OTHER] }), none = member({ areas: [] });
    assert.ok(audience(wide).has(some)); assert.ok(!audience(wide).has(none), 'a member who never chose an area is not notified');
    const unplaced = published([K]); file(`delete from notice_areas where notice_id='${unplaced}'`);
    assert.equal(audience(unplaced).size, 0, 'unspecified is not Shetland-wide');
  });
  test('5 EXCLUSIONS: not opted in, category not wanted, closed account, no valid device, master switch off, notices switch off, quiet hours', () => {
    const id = published([K]);
    const ok = member({ areas: [K] });
    const off = member({ areas: [K], community: false });
    const wrongCat = member({ areas: [K], cats: [OTHER_CAT] });
    const closed = member({ areas: [K] }); file(`update profiles set deleted_at = now(), is_active = false where id='${closed}'`);
    const noDevice = member({ areas: [K], token: null }), badToken = member({ areas: [K], token: 'not-a-valid-token' });
    const masterOff = member({ areas: [K], prefs: 'false, true, null, null' }), noticesOff = member({ areas: [K], prefs: 'true, false, null, null' });
    const quiet = member({ areas: [K], prefs: `true, true, ${nowWindow(1, 1)}` });
    const a = audience(id);
    assert.ok(a.has(ok), `baseline member missing: gate=${gate(ok)} size=${a.size}`);
    for (const [name, u] of Object.entries({ off, wrongCat, closed, noDevice, badToken, masterOff, noticesOff, quiet })) assert.ok(!a.has(u), `${name} must not be notified`);
    assert.equal(gate(ok), 'ok'); assert.equal(gate(noDevice), 'no_device'); assert.equal(gate(badToken), 'no_device'); assert.equal(gate(closed), 'inactive');
    assert.equal(gate(masterOff), 'preferences_off'); assert.equal(gate(noticesOff), 'preferences_off');
    assert.equal(gate(quiet), 'quiet_hours', 'a quiet-hours hold is told apart from a mute');
    const quietLater = member({ areas: [K], prefs: `true, true, ${nowWindow(-2, -4)}` }); assert.equal(gate(quietLater), 'ok', 'a quiet window that is not in force now does not block');
    assert.equal(gate(uuid()), 'inactive');
  });
  test('6 NO DUPLICATES: following several matching areas gives one recipient, and a member who already has a final delivery for this notice is never selected again', () => {
    const id = published([K, P]);
    const multi = member({ areas: [K, P] }); const a = raw(`select a from public.notice_member_audience('${id}') a where a = '${multi}'`).split('\n').filter((l) => l.trim() === multi);
    assert.equal(a.length, 1);
    for (const st of ['sent', 'held_quiet', 'skipped']) { const u = member({ areas: [K] }); file(`insert into notice_deliveries (subject_type, subject_id, user_id, kind, status) values ('notice','${id}','${u}','member','${st}')`); assert.ok(!audience(id).has(u), `${st} must be excluded`); }
    const failedTwice = member({ areas: [K] }); file(`insert into notice_deliveries (subject_type, subject_id, user_id, kind, status, attempts) values ('notice','${id}','${failedTwice}','member','failed',2)`); assert.ok(audience(id).has(failedTwice), `a failure is retried (gate=${gate(failedTwice)})`);
    file(`update notice_deliveries set attempts = 3 where user_id='${failedTwice}'`); assert.ok(!audience(id).has(failedTwice), 'three failures is final');
  });
  test('7 recipients and the preview agree: dispatch recipients == audience, and the staff preview estimate == its size, with no person named', () => {
    const id = published([K]); for (let i = 0; i < 3; i++) member({ areas: [K] });
    const aud = audience(id); assert.ok(aud.size >= 3); assert.deepEqual([...recipientsOf(id)].sort(), [...aud].sort(), `recipients ${recipientsOf(id).size} vs audience ${aud.size}`);
    const out = asUid(U.O, `select public.staff_member_notice_preview('${id}')`); assert.ok(!failed(out), out);
    const j = JSON.parse(out.split('\n').find((l) => l.trim().startsWith('{'))!);
    assert.equal(j.estimate, aud.size); assert.equal(j.can_notify, true); assert.equal(j.only_opted_in, true); assert.equal(j.daily_limit, 2); assert.equal(j.publisher, 'A OneShetland member');
    assert.ok(j.push_title && /Tap to read/.test(j.push_body) && j.areas.length === 1);
    const dump = JSON.stringify(j); for (const u of aud) assert.ok(!dump.includes(u), 'no recipient id is exposed'); assert.ok(!/@|ExponentPushToken|display_name/.test(dump));
    assert.deepEqual(Object.keys(j).sort(), ['area_state', 'areas', 'can_notify', 'daily_limit', 'estimate', 'expires_at', 'notice_id', 'only_opted_in', 'publisher', 'published_at', 'push_body', 'push_title', 'reason', 'status', 'title'].sort(), 'the preview carries counts and text only');
    for (const who of ['anon', 'A', 'A2', 'H', 'P'] as const) assert.match(as(who, `select public.staff_member_notice_preview('${id}')`), /Staff only|permission denied/, who);
    const exp = published([K], `expires_at = now() - interval '1 minute'`); const e = JSON.parse(asUid(U.O, `select public.staff_member_notice_preview('${exp}')`).split('\n').find((l) => l.trim().startsWith('{'))!);
    assert.deepEqual([e.can_notify, e.estimate], [false, 0]); assert.match(e.reason, /expired/);
  });
  test('8 the staff list shows published, unexpired member notices with whether each can be announced; others are not listed; non-staff are refused', () => {
    const ok = published([K]); const none = published([K]); file(`delete from notice_areas where notice_id='${none}'`); const exp = published([K], `expires_at = now() - interval '1 minute'`);
    const out = asUid(U.O, `select id, can_notify, area_state from public.staff_published_person_notices()`);
    assert.match(out, new RegExp(`${ok}\\|t\\|specific`)); assert.match(out, new RegExp(`${none}\\|f\\|none`)); assert.ok(!out.includes(exp), 'an expired notice is not offered');
    for (const who of ['anon', 'A', 'H'] as const) assert.match(as(who, `select * from public.staff_published_person_notices()`), /Staff only|permission denied/, who);
  });
});

describe('the 2-per-24-hours limit and reservations', () => {
  test('9 the cap counts SENT and RESERVED member notifications in the last 24 h only; held, skipped, failed and older ones do not count', () => {
    const u = member({ areas: [K] }); const ids = [published([K]), published([K]), published([K]), published([K])];
    const target = published([K]);
    const row = (n: string, st: string, ago: string) => file(`insert into notice_deliveries (subject_type, subject_id, user_id, kind, status, created_at, updated_at) values ('notice','${n}','${u}','member','${st}', now() - interval '${ago}', now() - interval '${ago}')`);
    row(ids[0], 'held_quiet', '1 hour'); row(ids[1], 'skipped', '1 hour'); row(ids[2], 'failed', '1 hour'); row(ids[3], 'sent', '25 hours');
    assert.ok(audience(target).has(u), 'none of those count'); assert.equal(scalar(`select public.notice_member_reserve('${target}','${u}')`), 'ok');
    const second = published([K]); assert.equal(scalar(`select public.notice_member_reserve('${second}','${u}')`), 'ok', 'two are allowed');
    const third = published([K]); assert.equal(scalar(`select public.notice_member_reserve('${third}','${u}')`), 'daily_limit', 'the third in 24 h is refused');
    assert.ok(!audience(third).has(u), 'and the preview already excludes this member');
    file(`update notice_deliveries set status = 'sent' where user_id='${u}' and subject_id in ('${target}','${second}')`);
    assert.equal(scalar(`select public.notice_member_reserve('${third}','${u}')`), 'daily_limit', 'sent ones count too');
    file(`update notice_deliveries set updated_at = now() - interval '25 hours', created_at = now() - interval '25 hours' where user_id='${u}' and subject_id in ('${target}','${second}')`);
    assert.equal(scalar(`select public.notice_member_reserve('${third}','${u}')`), 'ok', 'the window is ROLLING: it frees after 24 hours');
  });
  test('10 a retry re-reserves its own row without double counting; a final row is never re-opened', () => {
    const u = member({ areas: [K] }); const n = published([K]);
    assert.equal(scalar(`select public.notice_member_reserve('${n}','${u}')`), 'ok'); assert.equal(scalar(`select public.notice_member_reserve('${n}','${u}')`), 'ok');
    assert.equal(scalar(`select count(*) from notice_deliveries where subject_id='${n}' and user_id='${u}'`), '1');
    file(`update notice_deliveries set status = 'failed', attempts = 1 where subject_id='${n}' and user_id='${u}'`); assert.equal(scalar(`select public.notice_member_reserve('${n}','${u}')`), 'ok');
    assert.equal(scalar(`select status from notice_deliveries where subject_id='${n}' and user_id='${u}'`), 'pending');
    assert.ok(!failed(raw(`select public.notice_record_delivery('${n}','${u}','member','sent')`))); assert.equal(scalar(`select public.notice_member_reserve('${n}','${u}')`), 'already');
    raw(`select public.notice_record_delivery('${n}','${u}','member','failed','late error')`); assert.equal(scalar(`select status from notice_deliveries where subject_id='${n}' and user_id='${u}'`), 'sent', 'a sent row is final');
  });
  test('11 REAL CONCURRENCY: six simultaneous reservations for one member across six notices admit exactly TWO', async () => {
    const u = member({ areas: [K] }); const ns = Array.from({ length: 6 }, () => published([K]));
    const results = await Promise.all(ns.map((n) => pexec(PSQL, [DSN, '-X', '-q', '-t', '-A', '-c', `select public.notice_member_reserve('${n}','${u}')`]).then((r) => r.stdout.trim())));
    assert.equal(results.filter((r) => r === 'ok').length, 2, JSON.stringify(results)); assert.equal(results.filter((r) => r === 'daily_limit').length, 4);
    assert.equal(scalar(`select count(*) from notice_deliveries where user_id='${u}' and kind='member' and status='pending'`), '2');
  });
  test('12 the two-per-day cap is for member notices only: other audiences are untouched (an Essential or hub delivery neither counts nor is blocked)', () => {
    const u = member({ areas: [K] });
    const other = [published([K]), published([K])];
    for (const n of other) file(`insert into notice_deliveries (subject_type, subject_id, user_id, kind, status) values ('notice','${n}','${u}','essential','sent')`);
    const t = published([K]); assert.equal(scalar(`select public.notice_member_reserve('${t}','${u}')`), 'ok', 'essential deliveries are not member notifications');
  });
});

describe('the dispatch machinery is not reachable by clients, and approving is separate', () => {
  test('13 clients cannot call any dispatch, gate, reservation or audience function; approving a notice creates NO dispatch and NO delivery', () => {
    const id = published([K]);
    for (const fn of [`notice_push_gate('${U.A}')`, `notice_member_audience('${id}')`, `notice_member_reserve('${id}','${U.A}')`, `notice_member_push_text('${id}')`, `notice_claim_dispatch('${id}','member')`, `notice_record_delivery('${id}','${U.A}','member','sent')`])
      for (const who of ['anon', 'A', 'O', 'S'] as const) assert.match(as(who, `select * from public.${fn}`), /permission denied/, `${who} ${fn}`);
    assert.equal(scalar(`select count(*) from notice_dispatches where subject_id='${id}'`), '0'); assert.equal(scalar(`select count(*) from notice_deliveries where subject_id='${id}'`), '0');
    assert.equal(scalar(`select count(*) from notice_dispatches where kind='member'`), '0', 'no approval in this whole suite has started a dispatch');
  });
  test('14 the claim is once-only: a second claim is refused (409 path), and a completed dispatch can never be claimed again, edited notice or not', () => {
    const id = published([K]);
    assert.ok(!failed(raw(`select public.notice_claim_dispatch('${id}','member','${U.O}')`)));
    assert.match(raw(`select public.notice_claim_dispatch('${id}','member','${U.O}')`), /in progress/);
    const d = scalar(`select id from notice_dispatches where subject_id='${id}' and kind='member'`); raw(`select public.notice_complete_dispatch('${d}')`);
    assert.match(raw(`select public.notice_claim_dispatch('${id}','member','${U.S}')`), /Already announced/);
    // an edit sends the notice back to review; once re-approved it is STILL announced-already
    assert.ok(!failed(asUid(U.A, `select public.edit_my_person_notice('${id}','Edited title','An edited fictional body for the notice here.','other', array['${K}']::text[], null)`)));
    assert.ok(!failed(asUid(U.O, `select public.staff_approve_person_notice('${id}')`)));
    assert.match(raw(`select public.notice_claim_dispatch('${id}','member','${U.O}')`), /Already announced/, 'no automatic re-notification after an edit');
    assert.equal(scalar(`select count(*) from notice_audit_log where notice_id='${id}' and event='dispatch_claimed' and details->>'by'='${U.O}'`), '1', 'the staff action is in the audit trail');
  });
});

function N_LEGACY_ID() { return 'a1000000-0000-4000-8000-000000000001'; }
void q;
