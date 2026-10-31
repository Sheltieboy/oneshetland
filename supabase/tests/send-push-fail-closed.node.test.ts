/**
 * send-push-fail-closed.node.test.ts — the shared push sender (sendUserPush) FAILS CLOSED, proven on the REAL source with a fake Supabase client and a MOCK Expo.
 *
 * PROVES: a preference check that errors, throws, times out or answers with anything but true/false NEVER results in a push and is never reported as sent; a
 * transient fault is retried once so a legitimate notification is not dropped; opt-out, quiet hours, no device and provider failure each have their own explicit
 * result; urgent bypasses quiet hours only (never an opt-out, never a failed check); and the shared dispatcher records every one of those outcomes accurately
 * (sent only when the provider accepted; quiet hours is a FINAL skip, not a hold; failures retry up to 3 attempts and are never counted as delivered).
 * OFFLINE: no network, no Supabase, no Expo: the mock refuses every host except its own exp.host answer and loopback.
 */
import { test, describe, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadSendPush, fakeClient, mockExpo, type SendPushModule } from './_support/load-send-push.ts';
import { runDispatch, deliveryStatus } from '../functions/_shared/notice-dispatch.ts';

let M: SendPushModule;
const input = (over: Record<string, unknown> = {}) => ({ userId: 'u1', module: 'notices' as const, categoryId: 'notices.member', title: 'A notice', body: 'Tap to read.', urgent: false, ...over });
const allow = () => ({ data: true, error: null }), deny = () => ({ data: false, error: null });
let expo: ReturnType<typeof mockExpo>;
const run = async (o: Parameters<typeof fakeClient>[0], over: Record<string, unknown> = {}, answers: Parameters<typeof mockExpo>[0] = {}) => {
  expo = mockExpo(answers); expo.install();
  const { client, rec } = fakeClient(o); const res = await M.sendUserPush(client, input(over) as never);
  return { res, rec, sent: expo.sent };
};
before(async () => { M = await loadSendPush(); Object.assign(M.preferenceCheckConfig, { attempts: 2, timeoutMs: 40, retryDelayMs: 1 }); });
afterEach(() => expo?.restore());

describe('the sender: every outcome has an explicit result and only an accepted push is "sent"', () => {
  test('1 the check succeeds and allows: sent to the device(s), reason accepted (provider acceptance, not confirmed delivery), logged as sent', async () => {
    const r = await run({ should: allow, tokens: ['ExponentPushToken[a]', 'ExponentPushToken[b]'] });
    assert.deepEqual([r.res.status, r.res.reason, r.res.error], ['sent', 'accepted', undefined]); assert.equal(r.sent.length, 2); assert.equal(r.rec.logs.at(-1).status, 'sent');
    assert.equal(r.rec.rpc[0].args.p_urgent, false); assert.equal(r.rec.rpc[0].args.p_module, 'notices');
  });
  test('2 opted out (master switch or module off): nothing sent, skipped_pref / opted_out, logged skipped_pref', async () => {
    const r = await run({ should: deny });
    assert.deepEqual([r.res.status, r.res.reason, r.res.error], ['skipped_pref', 'opted_out', 'opted_out']); assert.equal(r.sent.length, 0); assert.equal(r.rec.logs.at(-1).status, 'skipped_pref');
  });
  test('3 quiet hours (blocked normally, allowed if urgent): nothing sent, skipped_quiet / quiet_hours (FINAL), logged skipped_quiet', async () => {
    const r = await run({ should: (a) => (a.p_urgent ? allow() : deny()) });
    assert.deepEqual([r.res.status, r.res.reason, r.res.error], ['skipped_quiet', 'quiet_hours', 'quiet_hours']); assert.equal(r.sent.length, 0); assert.equal(r.rec.logs.at(-1).status, 'skipped_quiet');
    assert.equal(r.rec.rpc.length, 2, 'the second question only labels the refusal; it can never turn a refusal into a send');
  });
  test('4 FAIL CLOSED: the preference rpc returns an error (both attempts): nothing is sent, status error / preference_check_failed, logged as an error, NEVER sent', async () => {
    const r = await run({ should: () => ({ data: null, error: { message: 'connection refused', code: '08006' } }) });
    assert.deepEqual([r.res.status, r.res.reason, r.res.error], ['error', 'preference_check_failed', 'preference_check_failed']);
    assert.equal(r.sent.length, 0); assert.equal(r.rec.rpc.length, 2, 'retried once'); assert.deepEqual([r.rec.logs.at(-1).status, r.rec.logs.at(-1).error], ['error', 'preference_check_failed']);
  });
  test('5 FAIL CLOSED: the preference rpc THROWS: nothing is sent', async () => {
    const r = await run({ should: () => { throw new Error('socket hang up'); } });
    assert.deepEqual([r.res.status, r.res.reason], ['error', 'preference_check_failed']); assert.equal(r.sent.length, 0);
  });
  test('6 FAIL CLOSED: the preference backend TIMES OUT (never answers): nothing is sent, and the sender does not hang', async () => {
    const t0 = Date.now(); const r = await run({ should: () => new Promise(() => {}) });
    assert.deepEqual([r.res.status, r.res.reason], ['error', 'preference_check_failed']); assert.equal(r.sent.length, 0); assert.ok(Date.now() - t0 < 2000);
  });
  test('7 FAIL CLOSED: an unusable answer (null, undefined, "true", 1, an object) is not permission', async () => {
    for (const data of [null, undefined, 'true', 1, 0, {}, []]) { const r = await run({ should: () => ({ data, error: null }) }); assert.equal(r.res.reason, 'preference_check_failed', String(JSON.stringify(data))); assert.equal(r.sent.length, 0); }
  });
  test('8 a TRANSIENT fault does not drop a legitimate notification: one failed check then a good one still sends', async () => {
    const r = await run({ should: (_a, n) => (n === 1 ? { data: null, error: { message: 'blip' } } : allow()) });
    assert.deepEqual([r.res.status, r.res.reason], ['sent', 'accepted']); assert.equal(r.sent.length, 1);
    const t = await run({ should: (_a, n) => (n === 1 ? new Promise(() => {}) : allow()) }); assert.equal(t.res.status, 'sent', 'a first timeout is retried');
  });
  test('9 URGENT bypasses quiet hours ONLY: allowed when only quiet hours would block; an urgent send to an opted-out member is still not sent; an urgent send with a failed check is not sent', async () => {
    const ok = await run({ should: (a) => (a.p_urgent ? allow() : deny()) }, { urgent: true }); assert.deepEqual([ok.res.status, ok.sent.length], ['sent', 1]); assert.equal(ok.rec.rpc[0].args.p_urgent, true);
    const out = await run({ should: deny }, { urgent: true }); assert.deepEqual([out.res.status, out.res.reason, out.sent.length], ['skipped_pref', 'opted_out', 0]);
    const bad = await run({ should: () => ({ data: null, error: { message: 'down' } }) }, { urgent: true }); assert.deepEqual([bad.res.status, bad.res.reason, bad.sent.length], ['error', 'preference_check_failed', 0]);
  });
  test('10 no device (none, or none valid; also a closed account whose tokens were removed): nothing sent, no_token / no_device', async () => {
    for (const tokens of [[], ['not-an-expo-token']]) { const r = await run({ should: allow, tokens }); assert.deepEqual([r.res.status, r.res.reason, r.res.error], ['no_token', 'no_device', 'no_device']); assert.equal(r.sent.length, 0); assert.equal(r.rec.logs.at(-1).status, 'no_token'); }
  });
  test('11 provider failure: the provider refuses every device → status error / provider_error, logged as an error, not sent; a stale token is pruned; one good device among bad is accepted', async () => {
    const bad = await run({ should: allow, tokens: ['ExponentPushToken[x]'] }, {}, { 'ExponentPushToken[x]': 'error' }); assert.deepEqual([bad.res.status, bad.res.reason, bad.rec.logs.at(-1).status], ['error', 'provider_error', 'error']);
    const gone = await run({ should: allow, tokens: ['ExponentPushToken[g]'] }, {}, { 'ExponentPushToken[g]': 'unregistered' }); assert.equal(gone.res.status, 'error'); assert.deepEqual(gone.rec.pruned, ['ExponentPushToken[g]']);
    const mixed = await run({ should: allow, tokens: ['ExponentPushToken[x]', 'ExponentPushToken[y]'] }, {}, { 'ExponentPushToken[x]': 'error' }); assert.deepEqual([mixed.res.status, mixed.res.reason], ['sent', 'accepted']);
  });
  test('12 the bulk helper never counts a failed check or a refusal as sent', async () => {
    expo = mockExpo(); expo.install(); const { client } = fakeClient({ should: (a) => (a.p_user_id === 'bad' ? { data: null, error: { message: 'x' } } : a.p_user_id === 'out' ? deny() : allow()) });
    const r = await M.sendUserPushBulk(client, ['ok', 'bad', 'out'], { module: 'notices', categoryId: 'notices.member', title: 't', body: 'b' } as never); assert.deepEqual(r, { sent: 1, skipped: 1, errored: 1, checkFailed: 1 });
  });
  test('12b beforeProvider: called after the check and device lookup and right before the provider; false or a throw sends nothing (claim_lost); never called when blocked or no device', async () => {
    let calls = 0; const hook = (v: boolean | 'throw') => async () => { calls++; if (v === 'throw') throw new Error('db down'); return v; };
    let r = await run({ should: allow }, { beforeProvider: hook(true) }); assert.equal(r.res.status, 'sent'); assert.equal(calls, 1); assert.equal(r.sent.length, 1);
    calls = 0; r = await run({ should: allow }, { beforeProvider: hook(false) }); assert.deepEqual([r.res.status, r.res.reason], ['error', 'claim_lost']); assert.equal(r.sent.length, 0);
    r = await run({ should: allow }, { beforeProvider: hook('throw') }); assert.equal(r.res.reason, 'claim_lost'); assert.equal(r.sent.length, 0);
    calls = 0; r = await run({ should: deny }, { beforeProvider: hook(true) }); assert.equal(calls, 0); r = await run({ should: () => ({ data: null, error: { message: 'x' } }) }, { beforeProvider: hook(true) }); assert.equal(calls, 0);
    r = await run({ should: allow, tokens: [] }, { beforeProvider: hook(true) }); assert.equal(calls, 0); assert.equal(r.res.reason, 'no_device');
  });
  test('13 a sender result is never "sent" unless the provider accepted: no code path returns sent after a failed check (source pin)', async () => {
    const { readFileSync } = await import('node:fs'); const src = readFileSync(new URL('../functions/_shared/send-push.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''), /fail-?open|Fail-open/i); assert.match(src, /preference_check_failed/);
    assert.equal((src.match(/return \{ status: 'sent'/g) ?? []).length + (src.match(/\? \{ status: 'sent'/g) ?? []).length, 1, 'exactly one place can return sent');
  });
});

describe('the shared dispatcher with the REAL sender: outcomes are recorded truthfully and failures retry up to 3 attempts', () => {
  type Scenario = { should: (a: any, n: number) => any; tokens?: string[]; answers?: any };
  async function dispatch(users: Record<string, Scenario>) {
    expo = mockExpo(Object.assign({}, ...Object.values(users).map((u) => u.answers ?? {}))); expo.install();
    const state = new Map<string, { status: string; attempts: number; error: string | null }>(); const calls: string[] = [];
    const final = (s: string) => ['sent', 'held_quiet', 'skipped'].includes(s);
    const rpc = async (fn: string, a: any) => {
      calls.push(fn);
      if (fn === 'notice_dispatchable') return { data: null, error: null };
      if (fn === 'notice_claim_dispatch') return { data: 'd1', error: null };
      if (fn === 'notice_dispatch_recipients') return { data: Object.keys(users).filter((u) => { const st = state.get(u); return !st || (!final(st.status) && st.attempts < 3); }).map((user_id) => ({ user_id })), error: null };
      if (fn === 'notice_record_delivery') { const cur = state.get(a.p_user); if (!cur || !final(cur.status)) state.set(a.p_user, { status: a.p_status, attempts: (cur?.attempts ?? 0) + (a.p_status === 'failed' ? 1 : 0), error: a.p_error }); return { data: null, error: null }; }
      return { data: null, error: null };
    };
    const clients = Object.fromEntries(Object.entries(users).map(([u, sc]) => [u, fakeClient({ should: sc.should, tokens: sc.tokens ?? ['ExponentPushToken[' + u + ']'] })]));
    const out = await runDispatch({ rpc: rpc as never, authorise: async () => ({ ok: true }), send: (u) => M.sendUserPush(clients[u].client, input({ userId: u }) as never) }, { type: 'notice', id: 'n1', kind: 'member', by: null });
    return { out: out as any, state, sent: expo.sent, calls };
  }
  test('14 every outcome is recorded accurately and "sent" == what the provider accepted; quiet hours is a FINAL skip with its reason (not a hold); failures are failed, never sent', async () => {
    const r = await dispatch({
      ok: { should: allow }, out: { should: deny }, quiet: { should: (a) => (a.p_urgent ? allow() : deny()) },
      broken: { should: () => ({ data: null, error: { message: 'down' } }) }, nodev: { should: allow, tokens: [] }, prov: { should: allow, answers: { 'ExponentPushToken[prov]': 'error' } },
    });
    const st = (u: string) => `${r.state.get(u)!.status}:${r.state.get(u)!.error ?? ''}`;
    assert.equal(st('ok'), 'sent:'); assert.equal(st('out'), 'skipped:opted_out'); assert.equal(st('quiet'), 'skipped:quiet_hours'); assert.equal(st('nodev'), 'skipped:no_device');
    assert.equal(r.state.get('broken')!.status, 'failed'); assert.equal(r.state.get('broken')!.error, 'preference_check_failed'); assert.equal(r.state.get('broken')!.attempts, 3);
    assert.equal(r.state.get('prov')!.status, 'failed'); assert.equal(r.state.get('prov')!.attempts, 3);
    assert.equal(r.out.sent, 1); assert.equal(r.out.quiet, 1); assert.equal(r.out.held, 0, 'nothing is described as held for later'); assert.equal(r.out.skipped, 2); assert.equal(r.out.failed, 6, 'three attempts each, counted as attempts');
    assert.deepEqual(r.sent.map((s) => s.to).filter((t) => t === 'ExponentPushToken[ok]'), ['ExponentPushToken[ok]'], 'the accepted member got exactly one push');
    assert.ok(![...r.state.values()].some((v) => v.status === 'held_quiet'), 'held_quiet is never written');
  });
  test('15 retry and duplicates: a transient failure succeeds on a later attempt and is then sent ONCE; a sent member is never sent again; nobody failing is ever counted as sent', async () => {
    const r = await dispatch({ flaky: { should: allow, answers: { 'ExponentPushToken[flaky]': ['error', 'ok'] } }, fine: { should: allow } });
    assert.equal(r.state.get('flaky')!.status, 'sent'); assert.equal(r.state.get('flaky')!.attempts, 1);
    assert.equal(r.sent.filter((s) => s.to === 'ExponentPushToken[fine]').length, 1, 'no duplicate for the member who succeeded first time');
    assert.equal(r.sent.filter((s) => s.to === 'ExponentPushToken[flaky]').length, 2, 'attempted twice, accepted once'); assert.equal(r.out.sent, 2);
  });
  test('16 the dispatcher status mapping: skipped_quiet and skipped_pref are final skips; no_token is a skip; error is failed; only sent is sent', () => {
    assert.deepEqual((['sent', 'skipped_pref', 'skipped_quiet', 'no_token', 'error'] as const).map(deliveryStatus), ['sent', 'skipped', 'skipped', 'skipped', 'failed']);
  });
});
