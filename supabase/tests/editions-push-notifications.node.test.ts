/**
 * editions-push-notifications.node.test.ts — OFFLINE (no database, no network). Editions push: followers (notify-edition-update) and organisers (editions-push-cron).
 * Proves, with the REAL handlers and the REAL shared sender against an in-memory database and a MOCK Expo: who may trigger, once-only sends, preferences / quiet hours / failed checks,
 * the payload (ids only, no personal data, no purchase wording), the fail-closed paths, and the order of the guard rails in source. Real push delivery is NOT exercised.
 * Run: node --test supabase/tests/editions-push-notifications.node.test.ts   (the database half is editions-push-notifications-sql: ISOLATED_ONLY=editions-push-notifications-sql npm run test:isolated)
 */
import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';
import { loadFunction, makeDb } from './_support/load-reminder-runner.ts';
import { mockExpo } from './_support/load-send-push.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const UPD = '11111111-1111-4111-8111-111111111111';
const ED = '22222222-2222-4222-8222-222222222222';
const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', U2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', U3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const tok = (u: string) => `ExponentPushToken[${u}]`;
const BANNED = /\b(price|prices|priced|buy|buying|bought|purchase|purchased|package|packages|promote|promoted|promotion|promotions|pay|paid|payment|checkout|subscribe|upgrade|£|\$)\b|[£$]/i;

let expo: ReturnType<typeof mockExpo>;
beforeEach(() => { expo = mockExpo(); expo.install(); });
afterEach(() => expo.restore());

describe('push text: ids only, no personal data, no purchase wording', () => {
  const T = loadModule('supabase/functions/_shared/edition-push-text.ts');
  test('follower message: title and body come from the row, data holds only slug / id / update id', () => {
    const m = T.followerUpdateMessage({ edition_id: ED, edition_slug: 'zz-fest', edition_title: 'ZZ Fest', update_title: 'Doors open at 7' }, UPD);
    assert.deepEqual(m, { title: 'ZZ Fest', body: 'Doors open at 7', categoryId: 'editions.update', data: { edition_slug: 'zz-fest', edition_id: ED, edition_update_id: UPD } });
  });
  test('text is cleaned: control characters and angle brackets removed, length capped, empty falls back to plain words', () => {
    const m = T.followerUpdateMessage({ edition_id: ED, edition_slug: 'zz', edition_title: `<b>${'x'.repeat(200)}</b>\u0000`, update_title: '' }, UPD);
    assert.ok(m.title.length <= 80 && !/[<>\u0000]/.test(m.title));
    assert.equal(m.body, 'There is a new update');
    assert.equal(T.followerUpdateMessage({ edition_id: ED, edition_slug: 'zz', edition_title: '', update_title: 'x' }, UPD).title, 'An Edition you saved');
  });
  test('organiser messages: four kinds only, no routable id (the Edition may not be public), no price / buy / package / promote wording', () => {
    for (const k of T.ORGANISER_KINDS) {
      const m = T.organiserMessage(k, 'ZZ Fest'); assert.ok(m, k);
      assert.doesNotMatch(`${m.title} ${m.body}`, BANNED, k);
      assert.deepEqual(Object.keys(m.data).sort(), ['event', 'topic'], `${k} carries no edition_slug / edition_id: a tap must not open a screen that may not exist yet`);
    }
    assert.equal(T.organiserMessage('partner_invited', 'x'), null);
    assert.equal(T.organiserMessage('refund', 'x'), null);
  });
  test('no purchase wording anywhere a push string is written', () => {
    for (const f of ['supabase/functions/_shared/edition-push-text.ts', 'supabase/functions/notify-edition-update/index.ts', 'supabase/functions/editions-push-cron/index.ts']) {
      for (const m of code(f).matchAll(/'([^'\n]{12,})'/g)) if (/\s/.test(m[1]) && !/^(authorization|https?:|x-client|Content-Type)/i.test(m[1])) assert.doesNotMatch(m[1], BANNED, `${f}: ${m[1]}`);
    }
  });
});

describe('authorisation gate (edition-update-notify-auth.ts)', () => {
  const D = loadModule('supabase/functions/_shared/notify-decision.ts');
  const A = loadModule('supabase/functions/_shared/edition-update-notify-auth.ts', { './notify-decision.ts': D });
  const fake = (o: { update?: boolean; lookupError?: boolean; allowed?: unknown; rpcError?: boolean } = {}) => {
    const calls: { fn: string; args: any }[] = [];
    return { calls, svc: {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => (o.lookupError ? { data: null, error: { message: 'x' } } : { data: o.update === false ? null : { id: UPD }, error: null }) }) }) }),
      rpc: async (fn: string, args: any) => { calls.push({ fn, args }); return o.rpcError ? { data: null, error: { message: 'x' } } : { data: o.allowed ?? false, error: null }; },
    } };
  };
  const user = { userId: U1, isServiceRole: false }, svcCaller = { userId: '', isServiceRole: true };
  test('missing or malformed update id is a 400 and nothing is looked up', async () => {
    for (const bad of [undefined, null, '', 'not-a-uuid', 7, { x: 1 }]) { const f = fake(); const r = await A.authoriseEditionUpdateNotify(f.svc, user, { updateId: bad }); assert.deepEqual([r.ok, r.status], [false, 400]); assert.equal(f.calls.length, 0); }
  });
  test('an update that does not exist is a 404; a failed lookup is a 503 (refused, not allowed)', async () => {
    assert.equal((await A.authoriseEditionUpdateNotify(fake({ update: false }).svc, user, { updateId: UPD })).status, 404);
    assert.equal((await A.authoriseEditionUpdateNotify(fake({ lookupError: true }).svc, user, { updateId: UPD })).status, 503);
  });
  test('a signed-in person is allowed only when the database says so, keyed by the update and their OWN id', async () => {
    const yes = fake({ allowed: true }); assert.equal((await A.authoriseEditionUpdateNotify(yes.svc, user, { updateId: UPD })).ok, true);
    assert.deepEqual(yes.calls, [{ fn: 'edition_update_notify_authorised', args: { p_update: UPD, p_user: U1 } }]);
    for (const answer of [false, null, 'true', 1, undefined]) { const r = await A.authoriseEditionUpdateNotify(fake({ allowed: answer }).svc, user, { updateId: UPD }); assert.deepEqual([r.ok, r.status], [false, 403], String(answer)); }
    const err = await A.authoriseEditionUpdateNotify(fake({ rpcError: true }).svc, user, { updateId: UPD }); assert.deepEqual([err.ok, err.status], [false, 403], 'a database error is a refusal');
  });
  test('the service role (our own backend) is allowed without asking the organiser question', async () => {
    const f = fake(); assert.equal((await A.authoriseEditionUpdateNotify(f.svc, svcCaller, { updateId: UPD })).ok, true); assert.equal(f.calls.length, 0);
  });
});

describe('source order and shape: guard rails run before anything is looked up or sent', () => {
  const src = read('supabase/functions/notify-edition-update/index.ts'), c = code('supabase/functions/notify-edition-update/index.ts');
  const at = (s: string) => { const i = c.indexOf(s); assert.ok(i > 0, `missing: ${s}`); return i; };
  test('caller -> rate limit -> body -> gate -> claim -> send -> complete, in that order', () => {
    const order = ['requireCaller(req', 'enforceRateLimit(', 'req.json()', 'authoriseEditionUpdateNotify(', "rpc('edition_update_notify_claim'", 'sendUserPushBulk(', "rpc('edition_update_notify_complete'"].map(at);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  });
  test('the gate runs before any other database access, and a denial returns straight away', () => {
    assert.equal(c.indexOf('createServiceClient()') < c.indexOf('authoriseEditionUpdateNotify('), true);
    assert.equal(c.slice(0, c.indexOf('authoriseEditionUpdateNotify(')).includes('.from('), false);
    assert.match(src, /if \(!decision\.ok\) return json\(\{ error: decision\.error \}, decision\.status\)/);
  });
  test('rate limited with the existing fan-out policies; the service role (our backend) is not throttled', () => {
    assert.match(c, /\['notify_fanout', 'notify_any'\]/); assert.match(c, /if \(!caller\.isServiceRole\)/);
  });
  test('only the update id is read from the request; recipients, titles and slug come from the database claim', () => {
    assert.deepEqual([...c.matchAll(/await req\.json\(\)/g)].length, 1); assert.match(c, /\(\{ update_id \} = await req\.json\(\)\)/);
    assert.doesNotMatch(c, /body\.|title\s*=\s*update_|req\.url|searchParams/);
  });
  test('not urgent (quiet hours apply), module events, sent in chunks, no email channel and no raw sendPush', () => {
    assert.match(c, /urgent: false/); assert.match(c, /module: 'events'/); assert.match(c, /CHUNK/);
    assert.doesNotMatch(c, /sendEmail|sendPush\(|urgent: true/);
  });
  test('a claim the database cannot answer sends nothing (503)', () => {
    assert.match(c, /claimError \|\| !claim[\s\S]*?\) return json\(\{ error: 'Service unavailable' \}, 503\)/);
  });
  test('editions-push-cron: service-role bearer compared in constant time before anything else; module business; not urgent; no raw sendPush', () => {
    const k = code('supabase/functions/editions-push-cron/index.ts');
    assert.ok(k.indexOf('safeEqual(bearer, key)') > 0 && k.indexOf('safeEqual(bearer, key)') < k.indexOf("rpc('edition_push_next'"));
    assert.match(k, /module: 'business'/); assert.match(k, /urgent: false/); assert.doesNotMatch(k, /sendPush\(|urgent: true|sendEmail/);
  });
  test('the migration exposes every function to the service role only', () => {
    const m = code('supabase/migrations/20270104030000_editions_push_notifications.sql');
    assert.match(m, /revoke all on function public\.%s from public, anon, authenticated/);
    assert.doesNotMatch(m, /grant[^;]*\bto\b[^;]*\b(authenticated|anon|public)\b/i.source ? new RegExp('grant[^;]*\\bto\\b[^;]*\\b(authenticated|anon|public)\\b', 'i') : /x/);
    assert.match(m, /revoke all on public\.edition_push_outbox from public, anon, authenticated/); assert.match(m, /revoke all on public\.edition_update_notifications from public, anon, authenticated/);
  });
});

type Db = ReturnType<typeof makeDb>;
const claimed = (recipients: string[]) => ({ status: 'claimed', edition_id: ED, edition_slug: 'zz-fest', edition_title: 'ZZ Fest', update_title: 'Doors open at 7', recipients });
const firstAsks = (d: Db) => { const seen = new Set<string>(); return d.calls.should_notify.filter((c) => (seen.has(c.user) ? false : (seen.add(c.user), true))); };
const withDevices = (d: Db, users: string[]) => { for (const u of users) d.table('push_tokens').push({ user_id: u, token: tok(u) }); return d; };

describe('notify-edition-update (REAL handler, REAL sender, mock Expo, in-memory database)', () => {
  let F: Awaited<ReturnType<typeof loadFunction>>;
  before(async () => { F = await loadFunction('notify-edition-update'); Object.assign(F.sendPush.preferenceCheckConfig, { attempts: 2, timeoutMs: 100, retryDelayMs: 1 }); });
  const seed = (claim: (a: any) => any = () => ({ data: claimed([U1, U2, U3]), error: null })) => {
    const d = withDevices(makeDb(), [U1, U2, U3]); d.table('edition_updates').push({ id: UPD, edition_id: ED });
    d.rpcHandlers.edition_update_notify_claim = claim; d.rpcHandlers.edition_update_notify_complete = () => ({ data: null, error: null }); return d;
  };

  test('1 a claimed update reaches every follower with a device; the payload is the slug, the id and the update id and nothing else', async () => {
    const d = seed(); const r = await F.call(d, { update_id: UPD });
    assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true, notified: 3, skipped: 0, errored: 0 });
    assert.deepEqual(expo.sent.map((m) => m.to).sort(), [U1, U2, U3].map(tok));
    assert.deepEqual(expo.sent.map((m) => [m.title, m.body, m.categoryId]), Array(3).fill(['ZZ Fest', 'Doors open at 7', 'editions.update']));
    const logged = d.table('notification_log'); assert.equal(logged.length, 3, 'one notification-centre row per follower');
    for (const l of logged) assert.deepEqual(l.data, { edition_slug: 'zz-fest', edition_id: ED, edition_update_id: UPD });
    assert.doesNotMatch(JSON.stringify(logged), /full_name|email|@/);
  });
  test('2 the claim is asked with the update id from the request and the caller (null for the service role); completion records the counts', async () => {
    const d = seed(); await F.call(d, { update_id: UPD });
    assert.deepEqual(d.calls.rpcArgs.filter((x) => x.fn.startsWith('edition_update')), [{ fn: 'edition_update_notify_claim', args: { p_update: UPD, p_actor: null } }, { fn: 'edition_update_notify_complete', args: { p_update: UPD, p_sent: 3, p_skipped: 0, p_errored: 0 } }]);
  });
  test('3 ONE SEND PER UPDATE: the second request for the same update sends nothing', async () => {
    let n = 0; const d = seed(() => ({ data: n++ === 0 ? claimed([U1, U2]) : { status: 'already' }, error: null }));
    await F.call(d, { update_id: UPD }); assert.equal(expo.sent.length, 2);
    const again = await F.call(d, { update_id: UPD }); assert.equal(again.json.notified, 0); assert.equal(again.json.skipped, 'already'); assert.equal(expo.sent.length, 2);
  });
  test('4 every refusal status sends nothing and says why (not public / not published / stale / too many)', async () => {
    for (const status of ['not_public', 'not_published', 'stale', 'too_many']) { const r = await F.call(seed(() => ({ data: { status }, error: null })), { update_id: UPD }); assert.deepEqual([r.status, r.json.skipped, r.json.notified], [200, status, 0]); }
    assert.equal(expo.sent.length, 0);
  });
  test('5 preferences and quiet hours are honoured (NOT urgent): opt-out, quiet hours and an unreadable check send nothing to that person; the others still get it', async () => {
    const d = seed(); d.setMode(U1, 'optout'); d.setMode(U2, 'quiet'); d.setMode(U3, 'error');
    const r = await F.call(d, { update_id: UPD });
    assert.equal(expo.sent.length, 0); assert.equal(r.json.notified, 0);
    assert.ok(firstAsks(d).length === 3 && firstAsks(d).every((c) => c.urgent === false), 'each person is first asked as non-urgent (the sender asks again as urgent only to tell quiet hours from an opt-out, and sends nothing)');
    expo.sent.length = 0; const ok = seed(); ok.setMode(U1, 'optout'); ok.setMode(U3, 'missing'); const r2 = await F.call(ok, { update_id: UPD });
    assert.deepEqual(expo.sent.map((m) => m.to).sort(), [tok(U2), tok(U3)]); assert.equal(r2.json.notified, 2);
  });
  test('6 a provider failure is not counted as notified', async () => {
    expo.restore(); expo = mockExpo({ [tok(U1)]: 'error', [tok(U2)]: 'error' }); expo.install();
    const r = await F.call(seed(), { update_id: UPD }); assert.equal(r.json.notified, 1); assert.equal(r.json.errored, 2);
  });
  test('7 a person without a device is simply not counted', async () => {
    const d = makeDb(); withDevices(d, [U2]); d.table('edition_updates').push({ id: UPD, edition_id: ED }); d.rpcHandlers.edition_update_notify_claim = () => ({ data: claimed([U1, U2]), error: null }); d.rpcHandlers.edition_update_notify_complete = () => ({ data: null, error: null });
    const r = await F.call(d, { update_id: UPD }); assert.equal(r.json.notified, 1); assert.deepEqual(expo.sent.map((m) => m.to), [tok(U2)]);
  });
  test('8 FAIL CLOSED: an unanswerable or malformed claim sends nothing (503); a malformed recipient id is dropped', async () => {
    for (const bad of [{ data: null, error: { message: 'down' } }, { data: null, error: null }, { data: { nostatus: 1 }, error: null }]) { const r = await F.call(seed(() => bad), { update_id: UPD }); assert.equal(r.status, 503); }
    assert.equal(expo.sent.length, 0);
    await F.call(seed(() => ({ data: claimed(['not-a-uuid', U1]), error: null })), { update_id: UPD }); assert.deepEqual(expo.sent.map((m) => m.to), [tok(U1)]);
  });
  test('9 request validation: no body, no id, a made-up id, an unknown update', async () => {
    assert.equal((await F.call(seed(), {})).status, 400); assert.equal((await F.call(seed(), { update_id: 'x' })).status, 400); assert.equal((await F.call(seed(), { update_id: 42 })).status, 400);
    const none = makeDb(); const r = await F.call(none, { update_id: UPD }); assert.equal(r.status, 404); assert.equal(expo.sent.length, 0);
    const h = (globalThis as any).__fnHandler as (r: Request) => Promise<Response>; (globalThis as any).__fakeDb = seed().client;
    assert.equal((await h(new Request('http://x/', { method: 'POST', headers: { Authorization: 'Bearer service-key-for-tests' }, body: 'not json' }))).status, 400);
  });
  test('10 no caller, no send: a missing or anon-style credential is refused before any database work', async () => {
    const h = (globalThis as any).__fnHandler as (r: Request) => Promise<Response>; const d = seed(); (globalThis as any).__fakeDb = d.client;
    const anon = `x.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.y`;
    for (const headers of [{}, { Authorization: `Bearer ${anon}` }]) assert.equal((await h(new Request('http://x/', { method: 'POST', headers, body: JSON.stringify({ update_id: UPD }) }))).status, 401);
    assert.equal(d.calls.rpc.length, 0); assert.equal(expo.sent.length, 0);
  });
});

describe('editions-push-cron (REAL handler, REAL sender, mock Expo)', () => {
  let F: Awaited<ReturnType<typeof loadFunction>>;
  before(async () => { F = await loadFunction('editions-push-cron'); Object.assign(F.sendPush.preferenceCheckConfig, { attempts: 2, timeoutMs: 100, retryDelayMs: 1 }); });
  const rows = [
    { id: 1, kind: 'edition_approved', user_id: U1, edition_id: ED }, { id: 2, kind: 'edition_changes_requested', user_id: U2, edition_id: ED },
    { id: 3, kind: 'edition_rejected', user_id: U3, edition_id: ED }, { id: 4, kind: 'package_active', user_id: U1, edition_id: ED }, { id: 5, kind: 'something_else', user_id: U1, edition_id: ED },
  ];
  const seed = (r = rows) => {
    const d = withDevices(makeDb(), [U1, U2, U3]); d.table('editions').push({ id: ED, title: 'ZZ Fest' }); const marks: { id: number; outcome: string }[] = [];
    d.rpcHandlers.edition_push_next = () => ({ data: r, error: null }); d.rpcHandlers.edition_push_mark = (a) => (marks.push({ id: a.p_id, outcome: a.p_outcome }), { data: null, error: null }); return { d, marks };
  };
  test('1 each due row is sent once to its own person with the Edition title, no route, no purchase wording; every row is marked', async () => {
    const { d, marks } = seed(); const r = await F.call(d, {});
    assert.deepEqual(r.json, { ok: true, sent: 4, held: 0, failed: 0 });
    assert.deepEqual(expo.sent.map((m) => [m.to, m.title, m.categoryId]), [[tok(U1), 'ZZ Fest', 'editions.edition_approved'], [tok(U2), 'ZZ Fest', 'editions.edition_changes_requested'], [tok(U3), 'ZZ Fest', 'editions.edition_rejected'], [tok(U1), 'ZZ Fest', 'editions.package_active']]);
    for (const m of expo.sent) assert.doesNotMatch(`${m.title} ${m.body}`, BANNED);
    for (const l of d.table('notification_log')) assert.deepEqual(Object.keys(l.data).sort(), ['event', 'topic'], 'the log (notification centre) row holds no slug, id or note');
    assert.deepEqual(marks.map((m) => m.outcome), ['accepted', 'accepted', 'accepted', 'accepted', 'skipped_unknown_kind']);
  });
  test('2 preferences and quiet hours are honoured and the outcome is recorded (held, never retried by this function)', async () => {
    const { d, marks } = seed(); d.setMode(U1, 'optout'); d.setMode(U2, 'quiet'); d.setMode(U3, 'error');
    const r = await F.call(d, {}); assert.equal(expo.sent.length, 0); assert.deepEqual([r.json.sent, r.json.held, r.json.failed], [0, 3, 1]);
    assert.deepEqual(marks.map((m) => m.outcome), ['opted_out', 'quiet_hours', 'preference_check_failed', 'opted_out', 'skipped_unknown_kind']);
    assert.ok(firstAsks(d).length === 3 && firstAsks(d).every((c) => c.urgent === false));
  });
  test('3 a person with no device is recorded as no_device', async () => {
    const { d, marks } = seed([rows[0]]); d.table('push_tokens').length = 0; (d.tables.push_tokens as any[]).splice(0); await F.call(d, {}); assert.deepEqual(marks, [{ id: 1, outcome: 'no_device' }]);
  });
  test('4 wrong, missing or anon credentials are refused and nothing is read or sent', async () => {
    const { d } = seed(); (globalThis as any).__fakeDb = d.client; const h = (globalThis as any).__fnHandler as (r: Request) => Promise<Response>;
    for (const headers of [{}, { Authorization: 'Bearer nope' }, { Authorization: 'Bearer anon' }]) assert.equal((await h(new Request('http://x/', { method: 'POST', headers }))).status, 401);
    assert.equal(d.calls.rpc.length, 0); assert.equal(expo.sent.length, 0);
  });
  test('5 an unavailable queue answers 503 and sends nothing (Editions off: the database returns no rows, so nothing is sent)', async () => {
    const { d } = seed(); d.rpcHandlers.edition_push_next = () => ({ data: null, error: { message: 'down' } }); assert.equal((await F.call(d, {})).status, 503);
    d.rpcHandlers.edition_push_next = () => ({ data: [], error: null }); const r = await F.call(d, {}); assert.deepEqual(r.json, { ok: true, sent: 0, held: 0, failed: 0 }); assert.equal(expo.sent.length, 0);
  });
});
