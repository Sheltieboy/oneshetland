/**
 * accept-member-notifications.node.test.ts — "Notify opted-in members" for an approved personal notice, end to end on the ISOLATED acceptance backend.
 *
 * WHAT RUNS: the REAL handler (functions/_shared/notice-audience.ts) and the REAL dispatcher; callers are identified by the LOCAL GoTrue (real JWTs); every
 * database call is PostgREST on the local stack with the real should_notify(). THE PUSH SENDER IS A MOCK (accept-functions.ts `push`): it records what WOULD have
 * been sent and sends nothing, anywhere. "sent" below therefore means "the mock accepted it", never a real delivered push notification.
 *   ACCEPT_RUN=1 node --test supabase/tests/api/accept-member-notifications.node.test.ts      (after accept-env.sh start + accept-seed.mjs)
 */
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { login, owner, rpc, URL_, ANON } from './_accept-client.ts';
import { handleAudienceLocal, push, localRpc, LOCAL_ENV } from './accept-functions.ts';
import { handleNoticeAudience } from '../../functions/_shared/notice-audience.ts';

const RUN = process.env.ACCEPT_RUN === '1';
const PW = 'Accept-Test-1', R = Date.now().toString(36);
let n = 0;
let K = '', P = '', SIB = '', OTHER = '';

const signUp = async (name: string): Promise<{ id: string; token: string }> => {
  const email = `mn-${R}-${++n}@accept.test`;
  const r = await (await fetch(`${URL_}/auth/v1/signup`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) })).json() as any;
  const id = (r.user ?? r).id as string;
  owner(`insert into profiles (id, role, display_name, full_name, onboarding_completed_at) values ('${id}', 'customer', '${name}', '${name}', now())`);
  const t = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) })).json() as any;
  return { id, token: t.access_token };
};
const call = async (tok: string, fn: string, args: Record<string, unknown> = {}) => {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: ANON, authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const t = await r.text(); return { status: r.status, data: t ? JSON.parse(t) : null };
};
/** a subscriber: opted in, follows the given areas, has a (fictional) device; options turn pieces off */
const subscriber = async (areas: string[], o: { community?: boolean; device?: boolean; prefs?: string; cats?: string[] } = {}) => {
  const u = await signUp('Fictional Subscriber');
  if (areas.length) assert.equal((await call(u.token, 'set_my_notice_areas', { p_areas: areas })).status, 200);
  if (o.community !== false) assert.equal((await call(u.token, 'set_my_notice_prefs', { p_community: true, ...(o.cats ? { p_categories: o.cats } : {}) })).status, 200);
  if (o.device !== false) owner(`insert into push_tokens (user_id, token) values ('${u.id}','ExponentPushToken[${u.id.slice(0, 8)}]')`);
  if (o.prefs) owner(`insert into notification_preferences (user_id, enabled, notices_enabled, quiet_hours_start, quiet_hours_end) values ('${u.id}', ${o.prefs})`);
  return u;
};
let author: { id: string; token: string };
/** a published personal notice (approval only: this NEVER notifies) */
const publishNotice = async (areas: string[], set = '') => {
  const s = await call(author.token, 'submit_person_notice', { p_title: `Fictional notice ${R}-${++n}`, p_body: 'A fictional member notice written for the notification acceptance tests.', p_category: 'other', p_area_ids: areas, p_expires_at: null });
  assert.equal(s.status, 200, JSON.stringify(s.data)); const id = s.data as string;
  owner(`update notices set created_at = created_at - interval '3 days' where id='${id}'`);
  const mod = await login('moderator'); const a = await rpc('moderator', 'staff_approve_person_notice', { p_notice: id }); assert.ok(a.status < 300, JSON.stringify(a.data)); void mod;
  if (set) owner(`update notices set ${set} where id='${id}'`);
  return id;
};
const ask = async (token: string | null, body: Record<string, unknown>, handler = handleAudienceLocal) => {
  const res = await handler(new Request('http://local/functions/v1/notify-notice-audience', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json().catch(() => null) as any };
};
const sentTo = (notice: string) => new Set(push.log.filter((p) => p.noticeId === notice).map((p) => p.userId));
const delivery = (notice: string, user: string) => owner(`select coalesce(status || ':' || coalesce(last_error,''), 'none') from notice_deliveries where subject_id='${notice}' and user_id='${user}'`) || 'none';
const dispatchRow = (notice: string) => owner(`select coalesce(status,'none') from notice_dispatches where subject_id='${notice}' and kind='member'`) || 'none';

const d = RUN ? describe : describe.skip;
d('moderator-controlled member notice notifications (mock push; isolated backend)', () => {
  let modTok = '', mod2Tok = '';
  before(async () => {
    assert.match(URL_, /^http:\/\/127\.0\.0\.1:/); push.reset();
    author = await signUp('Fictional Author');
    modTok = (await login('moderator')).token; mod2Tok = (await login('admin')).token;
    const kid = owner(`select a.id || ',' || a.parent_id from areas a join areas p on p.id = a.parent_id where p.type = 'locality' and a.is_active limit 1`).split(',');
    K = kid[0].trim(); P = kid[1].trim();
    SIB = owner(`select id from areas where parent_id = '${P}' and id <> '${K}' and is_active limit 1`).trim();
    OTHER = owner(`select id from areas where type = 'locality' and is_active and id <> '${P}' and coalesce(parent_id,'') <> '${P}' and id <> '${K}' order by id limit 1`).trim();
  });

  test('1 APPROVING NEVER NOTIFIES: a moderator approves, nothing is claimed, delivered or pushed, however many members would match', async () => {
    push.reset(); await subscriber([K]); await subscriber([K]);
    const id = await publishNotice([K]);
    assert.equal(owner(`select status from notices where id='${id}'`), 'published');
    assert.equal(dispatchRow(id), 'none'); assert.equal(owner(`select count(*) from notice_deliveries where subject_id='${id}'`), '0'); assert.equal(push.log.length, 0);
    const list = (await call(modTok, 'staff_published_person_notices')).data as any[]; const row = list.find((r) => r.id === id);
    assert.equal(row.can_notify, true, 'it can be announced, but only when staff choose to'); assert.equal(row.dispatch_status, null);
  });

  test('2 the moderator previews, then explicitly notifies: the eligible subscribers receive exactly one (mock) push; text has no names; staff see counts, not people', async () => {
    push.reset();
    const exact = await subscriber([K]), parent = await subscriber([P]), both = await subscriber([K, P]);
    const sibling = await subscriber([SIB]), unrelated = await subscriber([OTHER]), noArea = await subscriber([]);
    const optedOut = await subscriber([K], { community: false });
    const id = await publishNotice([K]);
    const pre = (await call(modTok, 'staff_member_notice_preview', { p_notice: id })).data;
    assert.equal(pre.can_notify, true); assert.ok(pre.estimate >= 3); assert.equal(pre.publisher, 'A OneShetland member'); assert.match(pre.push_body, /Tap to read/);
    assert.ok(!JSON.stringify(pre).match(/@accept\.test|ExponentPushToken/));
    const r = await ask(modTok, { notice_id: id, kind: 'member' });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.ok, true);
    const got = sentTo(id);
    for (const [name, u] of Object.entries({ exact, parent, both })) assert.ok(got.has(u.id), `${name} should receive it`);
    for (const [name, u] of Object.entries({ sibling, unrelated, noArea, optedOut })) assert.ok(!got.has(u.id), `${name} must not receive it`);
    assert.equal(push.log.filter((p) => p.noticeId === id && p.userId === both.id).length, 1, 'following several matching areas gives ONE push');
    assert.equal(got.size, pre.estimate, 'the preview estimate equals the real audience');
    assert.equal(r.json.sent, pre.estimate); assert.equal(dispatchRow(id), 'completed');
    for (const p of push.log.filter((x) => x.noticeId === id)) { assert.equal(p.kind, 'member'); assert.ok(!/Fictional (Author|Subscriber)/.test(p.title + p.body), 'no personal names'); assert.equal(p.body, 'A community notice for your area. Tap to read.'); }
    assert.equal(delivery(id, exact.id).split(':')[0], 'sent');
  });

  test('3 STATUS TRUTH: only what the sender accepted is "sent": no device, provider error and quiet hours are recorded as skipped / failed / held_quiet, never sent', async () => {
    push.reset();
    const ok = await subscriber([K]), noDevice = await subscriber([K], { device: false }), muted = await subscriber([K], { prefs: 'false, true, null, null' });
    const noticesOff = await subscriber([K], { prefs: 'true, false, null, null' });
    const quietNow = await subscriber([K], { prefs: `true, true, (now() at time zone 'Europe/London' - interval '1 hour')::time, (now() at time zone 'Europe/London' + interval '1 hour')::time` });
    const closed = await subscriber([K]); owner(`update profiles set deleted_at = now(), is_active = false where id='${closed.id}'`);
    const id = await publishNotice([K]);
    const audience = owner(`select count(*) from notice_member_audience('${id}')`);
    const r = await ask(modTok, { notice_id: id, kind: 'member' }); assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(sentTo(id).has(ok.id)); for (const [name, u] of Object.entries({ noDevice, muted, noticesOff, quietNow, closed })) assert.ok(!sentTo(id).has(u.id), `${name}: nothing pushed`);
    assert.equal(r.json.recipients, Number(audience), 'only the audience was even attempted');
    // the same members, if they BECOME ineligible during a run, are recorded truthfully (held / skipped), never as sent: see test 8
    assert.equal(r.json.sent, push.log.filter((p) => p.noticeId === id).length, 'sent == pushes the mock accepted');
  });

  test('4 REPEAT: a second request for the same notice is refused (409 Already announced) and nothing more is pushed; editing and re-approving does not re-notify', async () => {
    push.reset(); await subscriber([K]); const id = await publishNotice([K]);
    assert.equal((await ask(modTok, { notice_id: id, kind: 'member' })).status, 200); const first = push.log.length; assert.ok(first >= 1);
    const again = await ask(modTok, { notice_id: id, kind: 'member' }); assert.equal(again.status, 409); assert.match(again.json.error, /Already announced/);
    const other = await ask(mod2Tok, { notice_id: id, kind: 'member' }); assert.equal(other.status, 409, 'a different staff member cannot repeat it either');
    assert.equal((await call(author.token, 'edit_my_person_notice', { p_notice: id, p_title: 'Edited title', p_body: 'An edited fictional body for the notice here.', p_category: 'other', p_area_ids: [K], p_expires_at: null })).status < 300, true);
    assert.ok((await rpc('moderator', 'staff_approve_person_notice', { p_notice: id })).status < 300);
    assert.equal((await ask(modTok, { notice_id: id, kind: 'member' })).status, 409, 'no automatic re-notification after an edit'); assert.equal(push.log.length, first);
  });

  test('5 SIMULTANEOUS clicks: two staff requests at once → one runs, the other is refused; every member is pushed exactly once', async () => {
    push.reset(); const subs = []; for (let i = 0; i < 5; i++) subs.push(await subscriber([K]));
    const id = await publishNotice([K]);
    const [a, b] = await Promise.all([ask(modTok, { notice_id: id, kind: 'member' }), ask(mod2Tok, { notice_id: id, kind: 'member' })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.json, b.json]));
    for (const s of subs) assert.equal(push.log.filter((p) => p.noticeId === id && p.userId === s.id).length, 1, 'exactly one push per member');
    assert.equal(owner(`select count(*) from notice_dispatches where subject_id='${id}' and kind='member'`), '1');
    assert.equal(owner(`select count(*) from (select user_id from notice_deliveries where subject_id='${id}' group by user_id having count(*) > 1) x`), '0');
  });

  test('6 PARTIAL FAILURE AND RETRY: a provider error is retried within the run (up to 3 attempts) and recorded as failed, never sent; a crash mid-run can be resumed without duplicates', async () => {
    push.reset();
    const flaky = await subscriber([K]), dead = await subscriber([K]), fine = await subscriber([K]), crashy = await subscriber([K]);
    push.script.set(flaky.id, ['error', 'sent']); push.script.set(dead.id, ['error', 'error', 'error']); push.script.set(crashy.id, ['throw', 'sent']);
    const id = await publishNotice([K]);
    const r = await ask(modTok, { notice_id: id, kind: 'member' }); assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(delivery(id, flaky.id).split(':')[0], 'sent', 'a transient error succeeded on retry'); assert.equal(delivery(id, crashy.id).split(':')[0], 'sent');
    assert.equal(delivery(id, dead.id).split(':')[0], 'failed', 'three failures are final and are NOT recorded as sent'); assert.equal(owner(`select attempts from notice_deliveries where subject_id='${id}' and user_id='${dead.id}'`), '3');
    assert.equal(push.log.filter((p) => p.noticeId === id && p.userId === fine.id).length, 1); assert.equal(push.log.filter((p) => p.noticeId === id && p.userId === flaky.id).length, 2, 'attempted twice, delivered once');
    // a crash of the DISPATCH itself (the database call that completes it fails once): it can be resumed and nobody is pushed twice
    push.reset(); const late = await subscriber([K]); const id2 = await publishNotice([K]); let blown = false;
    const flakyRpc = async (fn: string, args: Record<string, unknown>) => { if (fn === 'notice_complete_dispatch' && !blown) { blown = true; return { data: null, error: { message: 'simulated outage', code: 'XX000' } }; } return localRpc(fn, args); };
    const handler = (req: Request) => handleNoticeAudience(req, { cors: {}, authenticate: async () => ({ caller: { userId: '', isServiceRole: true } }), rpc: flakyRpc as never, loadNotice: async (x) => ({ id: x, title: 't', body: 'b' }), push: async (u, t, c) => { push.log.push({ userId: u, title: t.title, body: t.body, kind: c.kind, noticeId: c.noticeId }); return { status: 'sent' as const }; } });
    const crash = await ask(LOCAL_ENV.SUPABASE_SERVICE_ROLE_KEY, { notice_id: id2, kind: 'member' }, handler as never); assert.equal(crash.status, 500); assert.equal(dispatchRow(id2), 'failed');
    const pushedBefore = push.log.length; assert.ok(pushedBefore >= 1);
    const resume = await ask(LOCAL_ENV.SUPABASE_SERVICE_ROLE_KEY, { notice_id: id2, kind: 'member' }, handler as never); assert.equal(resume.status, 200, JSON.stringify(resume.json)); assert.equal(dispatchRow(id2), 'completed');
    assert.equal(push.log.length, pushedBefore, 'resuming a crashed run pushes nobody a second time'); assert.equal(push.log.filter((p) => p.noticeId === id2 && p.userId === late.id).length, 1);
  });

  test('7 TWO PER 24 HOURS: a member who already received two member notices in the last day gets none; a third is "skipped (daily_limit)", never sent; essential alerts are separate', async () => {
    push.reset(); const busy = await subscriber([K]); const calm = await subscriber([K]);
    for (let i = 0; i < 2; i++) { const prior = await publishNotice([K]); owner(`insert into notice_deliveries (subject_type, subject_id, user_id, kind, status) values ('notice','${prior}','${busy.id}','member','sent')`); }
    const third = await publishNotice([K]);
    assert.equal(owner(`select count(*) from notice_member_audience('${third}') a where a = '${busy.id}'`), '0', 'the preview already excludes them');
    const r = await ask(modTok, { notice_id: third, kind: 'member' }); assert.equal(r.status, 200);
    assert.ok(!sentTo(third).has(busy.id)); assert.ok(sentTo(third).has(calm.id));
    // the cap can also be reached DURING a run (another dispatch took their slot after the audience was read): recorded as skipped, no push
    push.reset(); const racer = await subscriber([K]); const id = await publishNotice([K]); let done = false;
    const rpcSlot = async (fn: string, args: Record<string, unknown>) => {
      const out = await localRpc(fn, args);
      if (fn === 'notice_dispatch_recipients' && !done && JSON.stringify(out.data).includes(racer.id)) { done = true; for (let i = 0; i < 2; i++) { const x = await publishNotice([K]); owner(`insert into notice_deliveries (subject_type, subject_id, user_id, kind, status) values ('notice','${x}','${racer.id}','member','sent')`); } }
      return out;
    };
    const handler = (req: Request) => handleNoticeAudience(req, { cors: {}, authenticate: async () => ({ caller: { userId: '', isServiceRole: true } }), rpc: rpcSlot as never, loadNotice: async (x) => ({ id: x, title: 't' }), push: async (u, t, c) => { push.log.push({ userId: u, title: t.title, body: t.body, kind: c.kind, noticeId: c.noticeId }); return { status: 'sent' as const }; } });
    const rr = await ask(LOCAL_ENV.SUPABASE_SERVICE_ROLE_KEY, { notice_id: id, kind: 'member' }, handler as never); assert.equal(rr.status, 200, JSON.stringify(rr.json));
    assert.ok(!sentTo(id).has(racer.id)); assert.equal(delivery(id, racer.id), 'skipped:daily_limit', 'rate-limited is recorded as skipped, never as delivered');
  });

  test('8 QUIET HOURS are never overridden and never recorded as delivered: a member who enters quiet hours after the audience was read is held_quiet (no push, no catch-up)', async () => {
    push.reset(); const sleepy = await subscriber([K]); const awake = await subscriber([K]); const id = await publishNotice([K]); let flipped = false;
    const rpcQuiet = async (fn: string, args: Record<string, unknown>) => {
      const out = await localRpc(fn, args);
      if (fn === 'notice_dispatch_recipients' && !flipped && JSON.stringify(out.data).includes(sleepy.id)) { flipped = true; owner(`insert into notification_preferences (user_id, enabled, notices_enabled, quiet_hours_start, quiet_hours_end) values ('${sleepy.id}', true, true, (now() at time zone 'Europe/London' - interval '1 hour')::time, (now() at time zone 'Europe/London' + interval '1 hour')::time)`); }
      return out;
    };
    const handler = (req: Request) => handleNoticeAudience(req, { cors: {}, authenticate: async () => ({ caller: { userId: '', isServiceRole: true } }), rpc: rpcQuiet as never, loadNotice: async (x) => ({ id: x, title: 't' }), push: async (u, t, c) => { push.log.push({ userId: u, title: t.title, body: t.body, kind: c.kind, noticeId: c.noticeId }); return { status: 'sent' as const }; } });
    const r = await ask(LOCAL_ENV.SUPABASE_SERVICE_ROLE_KEY, { notice_id: id, kind: 'member' }, handler as never); assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(!sentTo(id).has(sleepy.id), 'no push during quiet hours'); assert.ok(sentTo(id).has(awake.id));
    assert.equal(delivery(id, sleepy.id), 'held_quiet:quiet_hours'); assert.equal(r.json.held, 1);
    owner(`delete from notification_preferences where user_id='${sleepy.id}'`);                                 // the quiet window ends: STILL no catch-up
    assert.equal((await ask(modTok, { notice_id: id, kind: 'member' })).status, 409); assert.ok(!sentTo(id).has(sleepy.id), 'there is no next-morning catch-up');
    assert.match(readSrc('supabase/functions/notify-notice-audience/index.ts'), /urgent: false/, 'the real sender is called with urgent:false (quiet hours honoured)');
  });

  test('9 INELIGIBLE NOTICES are refused with a reason and nothing is claimed or pushed: pending, withdrawn, expired, hidden, no place, resolved', async () => {
    push.reset(); await subscriber([K]);
    const pending = (await call(author.token, 'submit_person_notice', { p_title: `Pending ${R}`, p_body: 'A pending fictional notice for the tests.', p_category: 'other', p_area_ids: [K], p_expires_at: null })).data as string; owner(`update notices set created_at = created_at - interval '3 days' where id='${pending}'`);
    const cases: [string, string][] = [[pending, 'not published'], [await publishNotice([K], `status='withdrawn'`), 'not published'], [await publishNotice([K], `status='resolved'`), 'not published'],
      [await publishNotice([K], `expires_at = now() - interval '1 minute'`), 'expired'], [await publishNotice([K], `is_hidden = true`), 'hidden'], [await publishNotice([K]), 'no place chosen']];
    owner(`delete from notice_areas where notice_id='${cases[5][0]}'`);
    for (const [id, why] of cases) { const r = await ask(modTok, { notice_id: id, kind: 'member' }); assert.equal(r.status, 400, why); assert.match(r.json.error, new RegExp(why)); assert.equal(dispatchRow(id), 'none'); }
    assert.equal(push.log.length, 0);
    const preview = (await call(modTok, 'staff_member_notice_preview', { p_notice: cases[3][0] })).data; assert.deepEqual([preview.can_notify, preview.estimate], [false, 0]);
  });

  test('10 AUTHORISATION: only staff. The author, other members, a hub owner, an organisation publisher, the anon key, no token and a forged payload are all refused; nothing is claimed or pushed', async () => {
    push.reset(); await subscriber([K]); const id = await publishNotice([K]);
    const others = [author.token, (await signUp('Fictional Other')).token, (await login('hubowner')).token, (await login('official')).token, (await login('bizowner')).token];
    for (const t of others) assert.equal((await ask(t, { notice_id: id, kind: 'member' })).status, 403);
    assert.equal((await ask(ANON, { notice_id: id, kind: 'member' })).status, 401); assert.equal((await ask(null, { notice_id: id, kind: 'member' })).status, 401);
    assert.equal((await ask(author.token, { notice_id: id, kind: 'member', recipients: [author.id], urgent: true, as_staff: true, role: 'admin', p_user: modTok })).status, 403, 'a forged payload grants nothing');
    assert.equal((await ask(author.token, { notice_id: id, kind: 'community' })).status, 403); assert.equal((await ask(author.token, { notice_id: id, kind: 'official' })).status, 403);
    assert.equal(dispatchRow(id), 'none'); assert.equal(push.log.length, 0);
    for (const t of [author.token, others[1]]) { assert.ok((await call(t, 'staff_member_notice_preview', { p_notice: id })).status >= 400); assert.ok((await call(t, 'staff_published_person_notices')).status >= 400); }
    for (const fn of ['notice_claim_dispatch', 'notice_member_reserve', 'notice_push_gate', 'notice_member_audience']) assert.ok((await call(author.token, fn, { p_notice: id, p_kind: 'member', p_user: author.id })).status >= 400, fn);
    // a staff member whose account is closed holds no authority even with a still-valid token
    const staff2 = await signUp('Fictional Closed Mod'); owner(`update profiles set role='moderator', deleted_at = now(), is_active = false where id='${staff2.id}'`);
    assert.equal((await ask(staff2.token, { notice_id: id, kind: 'member' })).status, 403, 'a closed staff account cannot announce'); assert.equal(dispatchRow(id), 'none'); assert.equal(push.log.length, 0);
  });

  test('11 AUDIT: the staff action is recorded (who, which notice, which audience, the outcome); other notification kinds are unaffected', async () => {
    push.reset(); await subscriber([K]); const id = await publishNotice([K]);
    assert.equal((await ask(modTok, { notice_id: id, kind: 'member' })).status, 200);
    const modId = owner(`select id from profiles where display_name ilike '%Moderator%' limit 1`);
    assert.equal(owner(`select count(*) from notice_audit_log where notice_id='${id}' and event='dispatch_claimed' and details->>'kind'='member' and details->>'by'='${modId}'`), '1');
    assert.equal(owner(`select count(*) from notice_audit_log where notice_id='${id}' and event='dispatch_completed'`), '1');
    const hist = (await rpc('admin', 'admin_notice_dispatch_history', { p_notice: id })).data as any[]; assert.equal(hist[0].kind, 'member'); assert.equal(hist[0].status, 'completed'); assert.ok(hist[0].sent >= 1);
    assert.ok(!(await ask(modTok, { notice_id: id, kind: 'bogus' })).json.ok); assert.equal(owner(`select count(*) from notice_dispatches where kind not in ('essential','official','community','hub','funeral','member')`), '0');
  });
});

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const readSrc = (p: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', p), 'utf8');
