/**
 * notice-dispatch-core.node.test.ts — the dispatch orchestration (supabase/functions/_shared/notice-dispatch.ts) with a MOCKED database and a MOCKED sender.
 * No push, email or network request is ever made. The database rules themselves (eligibility, audience, deduplication, silence of imports) are proven in the
 * isolated-Postgres suites; this proves the orchestration calls them in the right order, never accepts or invents a recipient, never bypasses quiet hours,
 * survives failures, and resumes safely — and (by source inspection) that the deployed-function entry points keep the Stage 3A.1 safeguards.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDispatch, deliveryStatus, noticePushText, type Rpc, type PushStatus } from '../functions/_shared/notice-dispatch.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const N = 'a1000000-0000-4000-8000-000000000001';

type Call = { fn: string; args: Record<string, unknown> };
/** a scripted database: `batches` are the successive recipient lists; everything else is configurable */
function fakeDb(o: { eligible?: string | null; claimError?: { message: string; code?: string }; batches?: string[][]; recordError?: string; infinite?: boolean } = {}) {
  const calls: Call[] = []; let b = 0;
  const rpc: Rpc = async (fn, args) => {
    calls.push({ fn, args });
    if (fn === 'notice_dispatchable' || fn === 'funeral_dispatchable') return { data: o.eligible ?? null, error: null };
    if (fn === 'notice_claim_dispatch' || fn === 'funeral_claim_dispatch') return o.claimError ? { data: null, error: o.claimError } : { data: 'dispatch-1', error: null };
    if (fn === 'notice_dispatch_recipients' || fn === 'funeral_dispatch_recipients') {
      const rows = o.infinite ? [{ user_id: `u${b++}` }] : (o.batches?.[b++] ?? []).map((u) => ({ user_id: u }));
      return { data: rows, error: null };
    }
    if ((fn === 'notice_record_delivery' || fn === 'funeral_record_delivery') && o.recordError) return { data: null, error: { message: o.recordError } };
    return { data: null, error: null };
  };
  return { rpc, calls, names: () => calls.map((c) => c.fn) };
}
const ok = async () => ({ ok: true as const });
const subject = { type: 'notice' as const, id: N, kind: 'essential' as const, by: 'caller-1' };
const recorded = (calls: Call[]) => calls.filter((c) => c.fn === 'notice_record_delivery').map((c) => `${c.args.p_user}:${c.args.p_status}`);

describe('order, authority and refusal', () => {
  test('1 an unauthorised caller reaches NOTHING: no eligibility check, no claim, no send', async () => {
    const db = fakeDb({ batches: [['u1']] }); let sent = 0;
    const out = await runDispatch({ rpc: db.rpc, authorise: async () => ({ ok: false, status: 403, error: 'Not allowed' }), send: async () => { sent++; return { status: 'sent' }; } }, subject);
    assert.deepEqual(out, { ok: false, status: 403, error: 'Not allowed' });
    assert.equal(db.calls.length, 0); assert.equal(sent, 0);
  });
  test('2 an ineligible notice (withdrawn, expired, imported, wrong audience...) is refused BEFORE a claim and nothing is sent', async () => {
    for (const [reason, status] of [['That notice is not published', 400], ['Official source notices are never announced', 400], ['That notice does not exist', 404], ['Already announced', 409]] as const) {
      const db = fakeDb({ eligible: reason }); let sent = 0;
      const out = await runDispatch({ rpc: db.rpc, authorise: ok, send: async () => { sent++; return { status: 'sent' }; } }, subject);
      assert.deepEqual(out, { ok: false, status, error: reason }, reason);
      assert.deepEqual(db.names(), ['notice_dispatchable'], 'stops at the eligibility check');
      assert.equal(sent, 0);
    }
  });
  test('3 a lost claim (already announced / in progress) is a 409 and sends nothing', async () => {
    const db = fakeDb({ claimError: { message: 'Already announced', code: '23505' } }); let sent = 0;
    const out = await runDispatch({ rpc: db.rpc, authorise: ok, send: async () => { sent++; return { status: 'sent' }; } }, subject);
    assert.equal(out.ok, false); assert.equal((out as { status: number }).status, 409); assert.equal(sent, 0);
    assert.ok(!db.names().includes('notice_dispatch_recipients'));
  });
  test('4 the request supplies no recipients, text or urgency: the only inputs are the subject and the injected functions', () => {
    assert.equal(runDispatch.length, 2);
    const sig = src('supabase/functions/_shared/notice-dispatch.ts');
    assert.doesNotMatch(sig, /recipients\??:\s*string\[\]/, 'no recipient list parameter anywhere');
    assert.doesNotMatch(sig, /urgent\s*:\s*true/);
  });
});

describe('delivery, deduplication, failure and resume', () => {
  test('5 happy path: batches until the database returns nobody; one send and one record per member; completes once', async () => {
    const db = fakeDb({ batches: [['u1', 'u2', 'u3'], ['u4'], []] }); const sentTo: string[] = [];
    const out = await runDispatch({ rpc: db.rpc, authorise: ok, send: async (u) => { sentTo.push(u); return { status: 'sent' }; }, batchSize: 3 }, subject);
    assert.deepEqual(out, { ok: true, dispatch: 'dispatch-1', recipients: 4, sent: 4, held: 0, skipped: 0, failed: 0 });
    assert.deepEqual(sentTo.sort(), ['u1', 'u2', 'u3', 'u4']);
    assert.equal(db.names().filter((n) => n === 'notice_complete_dispatch').length, 1);
    assert.equal(db.names().filter((n) => n === 'notice_claim_dispatch').length, 1);
    assert.equal(db.calls.find((c) => c.fn === 'notice_claim_dispatch')!.args.p_kind, 'essential');
  });
  test('6 the same member returned twice in a batch (several areas / subscriptions) is sent ONCE', async () => {
    const db = fakeDb({ batches: [['u1', 'u1', 'u2', 'u1'], []] }); const sentTo: string[] = [];
    await runDispatch({ rpc: db.rpc, authorise: ok, send: async (u) => { sentTo.push(u); return { status: 'sent' }; } }, subject);
    assert.deepEqual(sentTo.sort(), ['u1', 'u2']);
  });
  test('7 push outcomes map to delivery states: sent / held_quiet (quiet hours) / skipped (opt-out, no token) / failed — quiet hours are held, never forced', async () => {
    const outcomes: PushStatus[] = ['sent', 'skipped_quiet', 'skipped_pref', 'no_token', 'error'];
    assert.deepEqual(outcomes.map(deliveryStatus), ['sent', 'held_quiet', 'skipped', 'skipped', 'failed']);
    const db = fakeDb({ batches: [['u1', 'u2', 'u3', 'u4', 'u5'], []] });
    const out = await runDispatch({ rpc: db.rpc, authorise: ok, send: async (u) => ({ status: outcomes[Number(u.slice(1)) - 1] }) }, subject);
    assert.deepEqual(recorded(db.calls).sort(), ['u1:sent', 'u2:held_quiet', 'u3:skipped', 'u4:skipped', 'u5:failed']);
    assert.equal(out.ok && out.held, 1); assert.equal(out.ok && out.failed, 1);
  });
  test('8 a sender that throws or rejects marks only that member failed; the rest are delivered and the dispatch still completes', async () => {
    const db = fakeDb({ batches: [['u1', 'u2', 'u3'], []] });
    const out = await runDispatch({ rpc: db.rpc, authorise: ok, send: async (u) => { if (u === 'u2') throw new Error('provider down'); return { status: 'sent' }; } }, subject);
    assert.ok(out.ok && out.sent === 2 && out.failed === 1);
    assert.ok(recorded(db.calls).includes('u2:failed'));
    assert.ok(db.names().includes('notice_complete_dispatch'));
  });
  test('9 an interruption (a delivery cannot be recorded) fails the dispatch so it can be RESUMED, and reports an error without a half-success', async () => {
    const db = fakeDb({ batches: [['u1'], []], recordError: 'connection lost' });
    const out = await runDispatch({ rpc: db.rpc, authorise: ok, send: async () => ({ status: 'sent' }) }, subject);
    assert.deepEqual(out, { ok: false, status: 500, error: 'The announcement was interrupted; it can be resumed' });
    assert.ok(db.names().includes('notice_fail_dispatch'));
    assert.ok(!db.names().includes('notice_complete_dispatch'));
  });
  test('10 withdrawn / expired DURING a run: the database returns nobody on the next batch and the run stops', async () => {
    const db = fakeDb({ batches: [['u1', 'u2'], []] }); const sentTo: string[] = [];
    const out = await runDispatch({ rpc: db.rpc, authorise: ok, send: async (u) => { sentTo.push(u); return { status: 'sent' }; }, batchSize: 2 }, subject);
    assert.ok(out.ok); assert.deepEqual(sentTo.sort(), ['u1', 'u2']);
    assert.equal(db.names().filter((n) => n === 'notice_dispatch_recipients').length, 2, 'it asked again and was told there was nobody');
  });
  test('11 a runaway recipient source cannot loop for ever: batches are capped', async () => {
    const db = fakeDb({ infinite: true });
    const out = await runDispatch({ rpc: db.rpc, authorise: ok, send: async () => ({ status: 'sent' }), maxBatches: 5 }, subject);
    assert.ok(out.ok && out.recipients === 5);
    assert.equal(db.names().filter((n) => n === 'notice_dispatch_recipients').length, 5);
  });
  test('12 a funeral announcement uses the funeral functions and kind, and nothing from the notices dispatch path', async () => {
    const db = fakeDb({ batches: [['m1'], []] });
    const out = await runDispatch({ rpc: db.rpc, authorise: ok, send: async () => ({ status: 'sent' }) }, { type: 'funeral', id: N, kind: 'funeral', by: null });
    assert.ok(out.ok);
    assert.deepEqual(db.names().filter((n) => /notice_(dispatchable|claim|dispatch_recipients|record)/.test(n)), []);
    assert.ok(['funeral_dispatchable', 'funeral_claim_dispatch', 'funeral_dispatch_recipients', 'funeral_record_delivery'].every((f) => db.names().includes(f)));
  });
});

describe('push text and the entry points', () => {
  test('13 essential alerts lead with what to do; text is clamped, plain and never carries markup or links from the notice', () => {
    const t = noticePushText('essential', { title: 'A970 closed at Voe junction', body: 'The road is closed. '.repeat(40), action_text: 'Use the Delting route and allow extra time.' });
    assert.equal(t.title, 'Essential alert: A970 closed at Voe junction'); assert.equal(t.body, 'Use the Delting route and allow extra time.');
    const long = noticePushText('community', { title: 'T'.repeat(300), body: 'B'.repeat(500) });
    assert.ok(long.title.length <= 110 && long.body.length <= 150 && long.title.endsWith('…'));
    assert.equal(noticePushText('essential', { title: 'Power cut', body: null, action_text: null }).body, 'Tap for details.');
    assert.equal(noticePushText('hub', { title: 'Hall closed' }, 'Voe Hall').title, 'New notice from Voe Hall');
  });
  test('14 the new entry points never set urgent, never read recipients from the request, and use the database authority checks', () => {
    for (const f of ['notify-notice-audience', 'notify-funeral-notice']) {
      const s = src(`supabase/functions/${f}/index.ts`);
      assert.match(s, /urgent:\s*false/, f); assert.doesNotMatch(s, /urgent:\s*true/, f);
      assert.doesNotMatch(s.replace(/\/\*[\s\S]*?\*\//g, ''), /req\.json\(\)[^;]*(recipients|user_ids|userIds)/, f);
      assert.match(s, /requireCaller/, f); assert.match(s, /enforceRateLimit/, f);
    }
    assert.match(src('supabase/functions/notify-notice-audience/index.ts'), /can_dispatch_notice/);
    assert.match(src('supabase/functions/notify-funeral-notice/index.ts'), /can_dispatch_funeral/);
    assert.match(src('supabase/functions/notify-funeral-notice/index.ts'), /funeral_notification_text/, 'the preview text comes from the database (family-approved), not the request');
  });
  test('15 R2: notify-hub-content announces a notice only through the dispatch core, from the STORED notice, and ignores the caller\'s title and any other hub', () => {
    const s = src('supabase/functions/notify-hub-content/index.ts');
    const branch = s.slice(s.indexOf("if (event === 'notice')"), s.indexOf('// Active, non-expired members.'));
    assert.match(branch, /runDispatch/); assert.match(branch, /kind: 'hub'/);
    assert.match(branch, /publisher_hub_id\?: string\s*\}\)\.publisher_hub_id !== hub_id/, 'the notice must belong to the hub the caller was authorised for');
    assert.match(branch, /noticePushText\('hub', notice/, 'text from the stored notice');
    assert.doesNotMatch(branch.replace(/\/\/.*$/gm, ''), /\btitle\s*\?\?/, 'the request title is not used for a notice');
    assert.match(branch, /urgent:\s*false/);
    assert.match(s, /authoriseHubContentNotify/, 'the hub owner / admin gate is unchanged');
  });
  test('16 the deployed Stage 3A.1 safeguards are untouched: notify-community-notice still refuses imports in the check AND the claim; broadcast gate unchanged', () => {
    const f = src('supabase/functions/notify-community-notice/index.ts');
    assert.match(f, /\.is\('source', null\)/); assert.match(f, /broadcastRefusal\(notice, nowMs\)/); assert.match(f, /urgent:\s+true/, 'the approved admin broadcast keeps its (only) quiet-hours bypass');
    const g = src('supabase/functions/_shared/notice-broadcast.ts');
    assert.match(g, /n\.source !== null/); assert.match(g, /Official source notices are not sent as alerts/);
  });
  test('17 no import path can announce: the dispatch core and entry points contain no reference to an importer, and the importer (when present) imports no push sender', () => {
    for (const f of ['supabase/functions/_shared/notice-dispatch.ts', 'supabase/functions/notify-notice-audience/index.ts', 'supabase/functions/notify-funeral-notice/index.ts']) {
      assert.doesNotMatch(src(f), /import-official-notices|notice-import/, f);
    }
  });
});
