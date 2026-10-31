/**
 * send-push-callers-runtime.node.test.ts — REAL Edge Function handlers (notify-job, notify-shift-status) running with the REAL shared sender, an in-memory database
 * and a MOCK Expo. Shows that legitimate sends still happen when preferences allow them, that an unreadable or negative preference sends nothing, that urgent
 * bypasses quiet hours ONLY (never an opt-out or a failed check), and that the handlers' own counts never include a push that was not accepted.
 * OFFLINE; "sent" = the MOCK provider accepted. No physical device is involved.
 */
import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadFunction, makeDb } from './_support/load-reminder-runner.ts';
import { mockExpo } from './_support/load-send-push.ts';

type Db = ReturnType<typeof makeDb>;
const tok = (u: string) => `ExponentPushToken[${u}]`;
const device = (d: Db, u: string) => d.table('push_tokens').push({ user_id: u, token: tok(u) });
let expo: ReturnType<typeof mockExpo>;
beforeEach(() => { expo = mockExpo(); expo.install(); }); afterEach(() => expo.restore());

describe('notify-job (jobs; "offer"/"hired" are urgent, "application" and "job_closed" are not)', () => {
  let F: Awaited<ReturnType<typeof loadFunction>>;
  before(async () => { F = await loadFunction('notify-job'); Object.assign(F.sendPush.preferenceCheckConfig, { attempts: 2, timeoutMs: 100, retryDelayMs: 1 }); });
  const seed = () => { const d = makeDb(); d.table('jobs').push({ id: 'j1', employer_id: 'emp', title: 'Net mender', posted_as_business_id: null });
    d.table('job_applications').push({ id: 'a1', applicant_id: 'app1', job_id: 'j1', status: 'offer' }, { id: 'a2', applicant_id: 'app2', job_id: 'j1', status: 'applied' }); for (const u of ['emp', 'app1', 'app2']) device(d, u); return d; };

  test('1 status "offer" (urgent) reaches the applicant when preferences allow, and is counted', async () => {
    const d = seed(); const r = await F.call(d, { event: 'status', application_id: 'a1', status: 'offer' }); assert.equal(r.status, 200); assert.deepEqual(expo.sent.map((m) => m.to), [tok('app1')]);
  });
  test('2 urgent bypasses QUIET HOURS only: sent in quiet hours; NOT sent when opted out; NOT sent when the check is unreadable', async () => {
    let d = seed(); d.setMode('app1', 'quiet'); await F.call(d, { event: 'status', application_id: 'a1', status: 'offer' }); assert.equal(expo.sent.length, 1, 'urgent + quiet hours -> sent');
    d = seed(); d.setMode('app1', 'optout'); await F.call(d, { event: 'status', application_id: 'a1', status: 'offer' }); assert.equal(expo.sent.length, 1, 'urgent never overrides an opt-out');
    d = seed(); d.setMode('app1', 'error'); await F.call(d, { event: 'status', application_id: 'a1', status: 'offer' }); assert.equal(expo.sent.length, 1, 'urgent never overrides a failed check');
  });
  test('3 non-urgent "application" to the employer: allowed -> sent; quiet hours / opt-out / unreadable -> nothing', async () => {
    const body = { event: 'application', application_id: 'a2' };
    await F.call(seed(), body); assert.equal(expo.sent.length, 1);
    for (const m of ['quiet', 'optout', 'error', 'throw'] as const) { const d = seed(); d.setMode('emp', m); await F.call(d, body); }
    assert.equal(expo.sent.length, 1, 'no further pushes for quiet/opt-out/error/throw');
  });
  test('4 job_closed bulk: only recipients whose preferences allow get it; "notified" counts accepted pushes only', async () => {
    const d = seed(); d.setMode('app1', 'optout'); d.setMode('app2', 'error');
    let r = await F.call(d, { event: 'job_closed', job_id: 'j1' }); assert.equal(r.json.notified, 0); assert.equal(expo.sent.length, 0);
    d.setMode('app2', 'allow'); r = await F.call(d, { event: 'job_closed', job_id: 'j1' }); assert.equal(r.json.notified, 1); assert.deepEqual(expo.sent.map((m) => m.to), [tok('app2')]);
  });
  test('5 missing preference row = enabled (existing transactional behaviour kept)', async () => { const d = seed(); d.setMode('app2', 'missing'); await F.call(d, { event: 'job_closed', job_id: 'j1' }); assert.equal(expo.sent.length, 2); });
  test('6 provider failure is not counted as notified', async () => {
    expo.restore(); expo = mockExpo({ [tok('app1')]: 'error', [tok('app2')]: 'error' }); expo.install(); const r = await F.call(seed(), { event: 'job_closed', job_id: 'j1' }); assert.equal(r.json.notified, 0);
  });
});

describe('notify-shift-status (cancellation is urgent: the worker must know)', () => {
  let F: Awaited<ReturnType<typeof loadFunction>>;
  before(async () => { F = await loadFunction('notify-shift-status'); Object.assign(F.sendPush.preferenceCheckConfig, { attempts: 2, timeoutMs: 100, retryDelayMs: 1 }); });
  const seed = () => { const d = makeDb(); d.table('shifts').push({ id: 's1', title: 'Pier shift', employer_id: 'emp' });
    d.table('shift_applications').push({ id: 'x1', shift_id: 's1', worker_id: 'w1', status: 'accepted' }, { id: 'x2', shift_id: 's1', worker_id: 'w2', status: 'pending' }, { id: 'x3', shift_id: 's1', worker_id: 'w3', status: 'pending' }); for (const u of ['w1', 'w2', 'w3', 'emp']) device(d, u); return d; };
  test('1 cancellation reaches every worker whose preferences allow it, including in quiet hours; counts accepted pushes', async () => {
    const d = seed(); d.setMode('w2', 'quiet'); const r = await F.call(d, { event: 'cancelled', shift_id: 's1' }); assert.equal(r.json.notified, 3); assert.equal(expo.sent.length, 3);
  });
  test('2 never overrides an opt-out or an unreadable check: those workers get nothing, the others still do', async () => {
    const d = seed(); d.setMode('w1', 'optout'); d.setMode('w3', 'error'); const r = await F.call(d, { event: 'cancelled', shift_id: 's1' });
    assert.deepEqual(expo.sent.map((m) => m.to), [tok('w2')]); assert.equal(r.json.notified, 1);
  });
  test('3 withdrawal notice to the employer is non-urgent: quiet hours / opt-out / error send nothing', async () => {
    const body = { event: 'withdrawn', application_id: 'x1' };
    await F.call(seed(), body); assert.equal(expo.sent.length, 1);
    for (const m of ['quiet', 'optout', 'error'] as const) { const d = seed(); d.setMode('emp', m); await F.call(d, body); }
    assert.equal(expo.sent.length, 1);
  });
});

/** the dispatch machinery (claim / recipients / record / complete) is database-side and proven in the isolated lane; here it is scripted so the HANDLER + REAL SENDER run end to end */
const scriptDispatch = (d: Db, recipients: string[]) => {
  let served = false; const recorded: { user: string; status: string; error: string | null }[] = [];
  d.rpcHandlers.notice_dispatchable = () => ({ data: null, error: null }); d.rpcHandlers.funeral_dispatchable = () => ({ data: null, error: null });
  d.rpcHandlers.notice_claim_dispatch = d.rpcHandlers.funeral_claim_dispatch = () => ({ data: 'dispatch-1', error: null });
  d.rpcHandlers.notice_dispatch_recipients = d.rpcHandlers.funeral_dispatch_recipients = () => { if (served) return { data: [], error: null }; served = true; return { data: recipients.map((user_id) => ({ user_id })), error: null }; };
  d.rpcHandlers.notice_record_delivery = (a) => (recorded.push({ user: a.p_user, status: a.p_status, error: a.p_error }), { data: null, error: null });
  d.rpcHandlers.funeral_record_delivery = d.rpcHandlers.notice_record_delivery; d.rpcHandlers.notice_complete_dispatch = () => ({ data: null, error: null });
  return recorded;
};
const UUID1 = '11111111-1111-4111-8111-111111111111';

describe('notify-hub-content (hub notices) end to end', () => {
  let F: Awaited<ReturnType<typeof loadFunction>>;
  before(async () => { F = await loadFunction('notify-hub-content'); Object.assign(F.sendPush.preferenceCheckConfig, { attempts: 2, timeoutMs: 100, retryDelayMs: 1 }); });
  const seed = () => { const d = makeDb(); d.table('hubs').push({ id: 'hub1', name: 'Voe Hall' }); d.table('notices').push({ id: UUID1, title: 'Hall closed Friday', publisher_hub_id: 'hub1' }); for (const u of ['m1', 'm2', 'm3', 'm4']) device(d, u); return d; };
  test('1 hub members whose preferences allow receive the notice through the real sender, recorded sent', async () => {
    const d = seed(); const rec = scriptDispatch(d, ['m1', 'm2']); const r = await F.call(d, { event: 'notice', hub_id: 'hub1', ref_id: UUID1 });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual(expo.sent.map((m) => m.to).sort(), [tok('m1'), tok('m2')]); assert.deepEqual(rec.map((x) => x.status), ['sent', 'sent']);
  });
  test('2 opt-out, quiet hours, unreadable check, no device: nothing is pushed and each is recorded truthfully (skipped / skipped(quiet_hours) / failed)', async () => {
    const d = seed(); d.setMode('m1', 'optout'); d.setMode('m2', 'quiet'); d.setMode('m3', 'error'); d.table('push_tokens').splice(d.table('push_tokens').findIndex((t) => t.user_id === 'm4'), 1);
    const rec = scriptDispatch(d, ['m1', 'm2', 'm3', 'm4']); const r = await F.call(d, { event: 'notice', hub_id: 'hub1', ref_id: UUID1 });
    assert.equal(expo.sent.length, 0); const by = Object.fromEntries(rec.map((x) => [x.user, x]));
    assert.equal(by.m1.status, 'skipped'); assert.equal(by.m2.status, 'skipped'); assert.equal(by.m2.error, 'quiet_hours'); assert.equal(by.m3.status, 'failed'); assert.equal(by.m3.error, 'preference_check_failed'); assert.equal(by.m4.status, 'skipped');
    assert.equal(r.json.notified, 0);
  });
});

describe('notify-funeral-notice (funeral announcements) end to end', () => {
  let F: Awaited<ReturnType<typeof loadFunction>>;
  before(async () => { F = await loadFunction('notify-funeral-notice'); Object.assign(F.sendPush.preferenceCheckConfig, { attempts: 2, timeoutMs: 100, retryDelayMs: 1 }); });
  const seed = () => { const d = makeDb(); d.rpcHandlers.funeral_notification_text = () => ({ data: [{ title: 'Funeral notice', body: 'A notice has been published for the Voe area.' }], error: null }); for (const u of ['m1', 'm2', 'm3']) device(d, u); return d; };
  test('1 opted-in followers are notified once; opt-out, quiet hours and an unreadable check are not, and are never urgent', async () => {
    const d = seed(); d.setMode('m2', 'quiet'); d.setMode('m3', 'error'); const rec = scriptDispatch(d, ['m1', 'm2', 'm3']); const r = await F.call(d, { funeral_id: UUID1 });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual(expo.sent.map((m) => m.to), [tok('m1')]); assert.deepEqual(rec.map((x) => x.status).sort(), ['failed', 'sent', 'skipped']);
    assert.ok(d.calls.should_notify.filter((c) => c.user === 'm1').every((c) => c.urgent === false), 'a funeral announcement never asks for the urgent bypass for an allowed member');
  });
});
