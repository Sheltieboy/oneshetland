/**
 * notify-entity-authorisation.node.test.ts — a signed-in account may only make OneShetland notify people about entities it is entitled to act on.
 *
 * WHAT WAS WRONG
 *
 * Seven notification functions — notify-application-update, notify-shift-application, notify-worker-checkin, notify-shift-complete,
 * notify-matching-workers, notify-drivers, notify-collected — checked only that the caller was signed in (auth.getUser()). The entity id in the
 * body (application_id, shift_id, request_id) went straight to a service-role lookup, and the push went out. So any account that knew or guessed a UUID
 * could: tell a worker "You're confirmed! 🎉" for an application it does not employ for; tell every accepted worker their shift was confirmed; push a
 * "New shift for you" fan-out for someone else's shift; tell an employer a worker applied / checked in; broadcast a customer's pickup and destination to
 * every approved driver, or tell a driver a run was cancelled; tell a customer their parcel was collected.
 *
 * HOW IT PROVES IT
 *
 * The REAL handlers and the REAL authorisation helpers run against an in-memory Supabase with stubbed push/rate-limit/caller IO — no network, no
 * database, no push is ever sent. Each attack is run first against the handler as it was before the fix (git show of the pre-fix commit) and must
 * SUCCEED, then against the fixed handler and must be refused with nothing sent. Every legitimate request shape — exactly what build 147 and the web app
 * send — must still work, the rate limits must still be claimed, and removing the authorisation call must bring each attack back.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadModule, REPO_ROOT } from './_support/load-source.ts';

type Row = Record<string, any>;
const BASE = 'c8ec42d';                       // origin/main before the fix: the handlers as they were

// ── the cast ────────────────────────────────────────────────────────────────────────────────────
const EMP = 'e1000000-0000-4000-8000-000000000001';        // employer of SHIFT_A
const EMP2 = 'e2000000-0000-4000-8000-000000000002';       // a different employer
const WA = 'a1000000-0000-4000-8000-0000000000a1';         // worker who applied to SHIFT_A
const WB = 'b1000000-0000-4000-8000-0000000000b1';         // another worker
const CUST = 'c1000000-0000-4000-8000-0000000000c1';       // customer of REQ
const CUST2 = 'c2000000-0000-4000-8000-0000000000c2';
const DRV = 'd1000000-0000-4000-8000-0000000000d1';        // driver of RUN
const DRV2 = 'd2000000-0000-4000-8000-0000000000d2';       // another approved driver
const NOBODY = 'f1000000-0000-4000-8000-0000000000f1';
const SHIFT_A = '51000000-0000-4000-8000-0000000000a1', SHIFT_B = '51000000-0000-4000-8000-0000000000b1';
const APP_A = '41000000-0000-4000-8000-0000000000a1';      // WA on SHIFT_A, accepted, checked in
const APP_A_PENDING = '41000000-0000-4000-8000-0000000000a2'; // WB on SHIFT_A, still pending
const APP_B = '41000000-0000-4000-8000-0000000000b1';      // WB on SHIFT_B (EMP2's)
const REQ = '71000000-0000-4000-8000-0000000000a1', RUN = '81000000-0000-4000-8000-0000000000a1';
const REQ_UNMATCHED = '71000000-0000-4000-8000-0000000000a2';

// ── a small stateful fake of the Supabase client ───────────────────────────────────────────────
let tables: Record<string, Row[]>;
function chain(table: string) {
  const f: ((r: Row) => boolean)[] = []; const c: any = {};
  c.select = () => c;
  c.eq = (k: string, v: unknown) => { f.push((r) => r[k] === v); return c; };
  c.neq = (k: string, v: unknown) => { f.push((r) => r[k] !== v); return c; };
  c.in = (k: string, v: unknown[]) => { f.push((r) => v.includes(r[k])); return c; };
  c.gte = (k: string, v: any) => { f.push((r) => String(r[k]) >= String(v)); return c; };
  for (const m of ['order', 'limit', 'is', 'not', 'or']) c[m] = () => c;
  const rows = () => (tables[table] ?? []).filter((r) => f.every((p) => p(r)));
  c.single = async () => ({ data: rows()[0] ?? null, error: null });
  c.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
  c.then = (res: any, rej: any) => Promise.resolve({ data: rows(), error: null }).then(res, rej);
  return c;
}
const db = () => ({ from: (t: string) => chain(t), rpc: async () => ({ data: null, error: null }) });

// ── stubbed IO ──────────────────────────────────────────────────────────────────────────────────
let pushes: { to: string[]; categoryId: string; title: string }[];
let limiterCalls: { fn: string; subject: string; classes: string[] }[];
let limiterDeny = false;
const sendUserPush = async (_s: any, i: Row) => { pushes.push({ to: [i.userId], categoryId: i.categoryId, title: i.title }); return { sent: 1 }; };
const sendUserPushBulk = async (_s: any, ids: string[], i: Row) => { pushes.push({ to: [...ids], categoryId: i.categoryId, title: i.title }); return { sent: ids.length }; };
const requireCaller = async (req: Request) => {
  const raw = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (raw === 'service') return { caller: { userId: '', isServiceRole: true } };
  if (raw.startsWith('user-')) return { caller: { userId: raw.slice(5), isServiceRole: false } };
  return { denied: new Response(JSON.stringify({ error: 'Unauthorised' }), { status: 401 }) };
};
const enforceRateLimit = async (fn: string, subject: string, classes: string[]) => {
  limiterCalls.push({ fn, subject, classes });
  return limiterDeny ? { denied: new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 }) } : { ok: true };
};
const userSubject = (id: string) => `user:${id}`;

const decisionMod = () => loadModule('supabase/functions/_shared/notify-decision.ts');
const shiftAuth = () => loadModule('supabase/functions/_shared/shift-notify-auth.ts', { './notify-decision.ts': decisionMod() });
const fetchAuth = () => loadModule('supabase/functions/_shared/fetch-notify-auth.ts', { './notify-decision.ts': decisionMod() });

let handler: (r: Request) => Promise<Response>;
/** `how`: 'fixed' = the handler in the tree; 'baseline' = the handler before the fix; a function = the fixed source after that mutation. */
function load(fn: string, how: 'fixed' | 'baseline' | ((src: string) => string) = 'fixed') {
  const rel = `supabase/functions/${fn}/index.ts`;
  const transform = how === 'fixed' ? undefined
    : how === 'baseline' ? () => execFileSync('git', ['show', `${BASE}:${rel}`], { cwd: REPO_ROOT, encoding: 'utf8' })
    : how;
  loadModule(rel, {
    'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: any) => { handler = h; } },
    'https://esm.sh/@supabase/supabase-js@2': {
      createClient: (_u: string, key: string, opts: Row = {}) => key === 'anon-key'
        ? { auth: { getUser: async () => { const a = String(opts?.global?.headers?.Authorization ?? ''); return a.startsWith('Bearer user-') ? { data: { user: { id: a.slice(12) } }, error: null } : { data: { user: null }, error: { message: 'no' } }; } } }
        : db(),
    },
    '../_shared/send-push.ts': { sendUserPush, sendUserPushBulk, createServiceClient: db },
    '../_shared/safe-error.ts': { safeError: (_n: string, e: unknown) => String(e) },
    '../_shared/rate-limit.ts': { enforceRateLimit, userSubject },
    '../_shared/require-caller.ts': { requireCaller },
    '../_shared/shift-notify-auth.ts': shiftAuth(),
    '../_shared/fetch-notify-auth.ts': fetchAuth(),
  }, transform);
}
const noDecision = (src: string) => {
  const out = src.replace(/\n\s*const decision = await authorise\w+\([\s\S]*?\n\s*\}\n/, '\n');
  assert.notEqual(out, src, 'the authorisation call was not found to remove');
  return out;
};

type As = string | 'service' | null;
const call = (fn: string, as: As, body: Row = {}) => handler(new Request(`https://fake.supabase.co/functions/v1/${fn}`, {
  method: 'POST', headers: as ? { Authorization: `Bearer ${as === 'service' ? 'service' : as.startsWith('raw:') ? as.slice(4) : `user-${as}`}` } : {}, body: JSON.stringify(body),
}));
const status = async (p: Promise<Response>) => (await p).status;

function seed() {
  (globalThis as any).Deno = { env: { get: (k: string) => ({ SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'svc-key' } as Row)[k] } };
  pushes = []; limiterCalls = []; limiterDeny = false;
  tables = {
    shifts: [
      { id: SHIFT_A, employer_id: EMP, status: 'open', title: 'Gutting at the pier', category: 'fishing', urgency: 'normal', pay_type: 'hourly', pay_amount: 15, location_text: 'Scalloway' },
      { id: SHIFT_B, employer_id: EMP2, status: 'open', title: 'Other shift', category: 'fishing', urgency: 'normal', pay_type: 'hourly', pay_amount: 12, location_text: 'Lerwick' },
    ],
    shift_applications: [
      { id: APP_A, shift_id: SHIFT_A, worker_id: WA, status: 'accepted', checked_in_at: '2026-10-08T08:00:00Z', checked_out_at: null },
      { id: APP_A_PENDING, shift_id: SHIFT_A, worker_id: WB, status: 'pending', checked_in_at: null, checked_out_at: null },
      { id: APP_B, shift_id: SHIFT_B, worker_id: WB, status: 'accepted', checked_in_at: null, checked_out_at: null },
    ],
    shift_alerts: [{ user_id: WA, categories: ['fishing'], urgency: [], min_pay: null, is_active: true }, { user_id: WB, categories: [], urgency: [], min_pay: null, is_active: true }, { user_id: EMP, categories: [], urgency: [], min_pay: null, is_active: true }],
    profiles: [{ id: WA, full_name: 'Worker A' }, { id: WB, full_name: 'Worker B' }],
    delivery_requests: [
      { id: REQ, customer_id: CUST, run_id: RUN, status: 'matched', category_slug: 'parcel', pickup_name: 'Shop', destination_area: 'Walls', destination_address: 'x, y', base_fee_pence: 800, destination_region_id: null, needed_by: null },
      { id: REQ_UNMATCHED, customer_id: CUST2, run_id: null, status: 'pending', category_slug: 'parcel', pickup_name: 'Co-op', destination_area: 'Sandwick', destination_address: 'a, b', base_fee_pence: 900, destination_region_id: null, needed_by: null },
    ],
    runs: [{ id: RUN, driver_id: DRV, status: 'open' }],
    driver_profiles: [{ id: DRV, driver_status: 'approved' }, { id: DRV2, driver_status: 'approved' }],
  };
}
beforeEach(seed);
const setReq = (id: string, patch: Row) => { Object.assign(tables.delivery_requests.find((r) => r.id === id)!, patch); };
const setApp = (id: string, patch: Row) => { Object.assign(tables.shift_applications.find((r) => r.id === id)!, patch); };
const setShift = (id: string, patch: Row) => { Object.assign(tables.shifts.find((r) => r.id === id)!, patch); };

/** request bodies exactly as build 147 (lib/shifts-api.ts, app/(customer)/*, app/(driver)/*) and the web app (components/jobs, components/fetch) send them */
const BODIES = {
  'notify-application-update': [{ application_id: APP_A, status: 'accepted' }],
  'notify-shift-application': [{ application_id: APP_A }],
  'notify-worker-checkin': [{ application_id: APP_A, event: 'checked_in' }],
  'notify-shift-complete': [{ shift_id: SHIFT_A }],
  'notify-matching-workers': [{ shift_id: SHIFT_A }],
  'notify-drivers': [{ request_id: REQ_UNMATCHED }, { request_id: REQ, event: 'cancelled' }],
  'notify-collected': [{ request_id: REQ }],
};
/** who legitimately sends each body, and what must be true of the row when they do (the apps write first, notify second) */
const LEGIT: { fn: keyof typeof BODIES; as: string; body: Row; ready: () => void; expectCategory: string }[] = [
  { fn: 'notify-application-update', as: EMP, body: { application_id: APP_A, status: 'accepted' }, ready: () => {}, expectCategory: 'shifts.application_accepted' },
  { fn: 'notify-application-update', as: EMP, body: { application_id: APP_A_PENDING, status: 'rejected', reason: 'filled' }, ready: () => setApp(APP_A_PENDING, { status: 'rejected' }), expectCategory: 'shifts.application_rejected' },
  { fn: 'notify-shift-application', as: WA, body: { application_id: APP_A }, ready: () => {}, expectCategory: 'shifts.new_application' },
  { fn: 'notify-worker-checkin', as: WA, body: { application_id: APP_A, event: 'checked_in' }, ready: () => {}, expectCategory: 'shifts.worker_checked_in' },
  { fn: 'notify-worker-checkin', as: WA, body: { application_id: APP_A, event: 'checked_out' }, ready: () => setApp(APP_A, { checked_out_at: '2026-10-08T16:00:00Z' }), expectCategory: 'shifts.worker_checked_out' },
  { fn: 'notify-shift-complete', as: EMP, body: { shift_id: SHIFT_A }, ready: () => setShift(SHIFT_A, { status: 'completed' }), expectCategory: 'shifts.complete' },
  { fn: 'notify-matching-workers', as: EMP, body: { shift_id: SHIFT_A }, ready: () => {}, expectCategory: 'shifts.new_match' },
  { fn: 'notify-drivers', as: CUST2, body: { request_id: REQ_UNMATCHED }, ready: () => {}, expectCategory: 'fetch.new_request' },
  { fn: 'notify-drivers', as: CUST, body: { request_id: REQ, event: 'cancelled' }, ready: () => setReq(REQ, { status: 'cancelled' }), expectCategory: 'fetch.request_cancelled' },
  { fn: 'notify-collected', as: DRV, body: { request_id: REQ }, ready: () => setReq(REQ, { status: 'collected' }), expectCategory: 'fetch.collected' },
];

/** each attack: who, with what, against which function — all supplied by an authenticated ordinary account */
const ATTACKS: { name: string; fn: keyof typeof BODIES; as: string; body: Row; ready?: () => void }[] = [
  { name: 'tell another employer\'s worker they are confirmed', fn: 'notify-application-update', as: NOBODY, body: { application_id: APP_A, status: 'accepted' } },
  { name: 'a different EMPLOYER confirms an application on a shift that is not theirs', fn: 'notify-application-update', as: EMP2, body: { application_id: APP_A, status: 'accepted' } },
  { name: 'the WORKER confirms their own application', fn: 'notify-application-update', as: WA, body: { application_id: APP_A, status: 'accepted' } },
  { name: 'announce an application that was never made to the employer', fn: 'notify-shift-application', as: NOBODY, body: { application_id: APP_A } },
  { name: 'another worker reports an application that is not theirs', fn: 'notify-shift-application', as: WB, body: { application_id: APP_A } },
  { name: 'impersonate a worker checking in', fn: 'notify-worker-checkin', as: NOBODY, body: { application_id: APP_A, event: 'checked_in' } },
  { name: 'the EMPLOYER pretends the worker checked in', fn: 'notify-worker-checkin', as: EMP, body: { application_id: APP_A, event: 'checked_in' } },
  { name: 'confirm a shift complete for every accepted worker of another employer', fn: 'notify-shift-complete', as: NOBODY, body: { shift_id: SHIFT_A }, ready: () => setShift(SHIFT_A, { status: 'completed' }) },
  { name: 'a different employer confirms another employer\'s shift', fn: 'notify-shift-complete', as: EMP2, body: { shift_id: SHIFT_A }, ready: () => setShift(SHIFT_A, { status: 'completed' }) },
  { name: 'fan "New shift for you" out for someone else\'s shift', fn: 'notify-matching-workers', as: NOBODY, body: { shift_id: SHIFT_A } },
  { name: 'a different employer fans out another employer\'s shift', fn: 'notify-matching-workers', as: EMP2, body: { shift_id: SHIFT_A } },
  { name: 'broadcast a stranger\'s pickup and destination to every approved driver', fn: 'notify-drivers', as: NOBODY, body: { request_id: REQ_UNMATCHED } },
  { name: 'tell a driver somebody else\'s run was cancelled', fn: 'notify-drivers', as: NOBODY, body: { request_id: REQ, event: 'cancelled' }, ready: () => setReq(REQ, { status: 'cancelled' }) },
  { name: 'the DRIVER cancels a customer\'s request on their behalf', fn: 'notify-drivers', as: DRV, body: { request_id: REQ, event: 'cancelled' }, ready: () => setReq(REQ, { status: 'cancelled' }) },
  { name: 'tell a customer their parcel was collected', fn: 'notify-collected', as: NOBODY, body: { request_id: REQ }, ready: () => setReq(REQ, { status: 'collected' }) },
  { name: 'another approved driver reports a collection on a run that is not theirs', fn: 'notify-collected', as: DRV2, body: { request_id: REQ }, ready: () => setReq(REQ, { status: 'collected' }) },
  { name: 'the CUSTOMER reports their own parcel collected', fn: 'notify-collected', as: CUST, body: { request_id: REQ }, ready: () => setReq(REQ, { status: 'collected' }) },
];

const FUNCS = Object.keys(BODIES) as (keyof typeof BODIES)[];

describe('before the fix: authentication alone let every one of these attacks through (controls)', () => {
  for (const a of ATTACKS) {
    test(`ATTACK SUCCEEDS on the old handler — ${a.name}`, async () => {
      load(a.fn, 'baseline'); a.ready?.();
      assert.equal(await status(call(a.fn, a.as, a.body)), 200);
      assert.ok(pushes.length > 0, 'the old handler sent the notification');
    });
  }
});

describe('after the fix: the same attacks are refused and nothing is sent', () => {
  for (const a of ATTACKS) {
    test(`REFUSED — ${a.name}`, async () => {
      load(a.fn); a.ready?.();
      const s = await status(call(a.fn, a.as, a.body));
      assert.ok(s === 403 || s === 409, `expected a refusal, got ${s}`);
      assert.deepEqual(pushes, []);
    });
  }

  test('1. unauthenticated, and the anon key (no subject), are rejected by every function', async () => {
    for (const fn of FUNCS) {
      load(fn);
      assert.equal(await status(call(fn, null, BODIES[fn][0])), 401, fn);
      assert.equal(await status(call(fn, 'raw:anon-key-no-subject', BODIES[fn][0])), 401, fn);
    }
    assert.deepEqual(pushes, []);
  });

  for (const l of LEGIT) {
    test(`2/4/11. LEGITIMATE — ${l.fn} by the right actor (${JSON.stringify(l.body)}) still works`, async () => {
      load(l.fn); l.ready();
      assert.equal(await status(call(l.fn, l.as, l.body)), 200);
      assert.equal(pushes.length, 1);
      assert.equal(pushes[0].categoryId, l.expectCategory);
    });
  }

  test('3/6/8. an unrelated user, another business\'s employer, or another worker cannot invoke an employer or worker notification', async () => {
    setShift(SHIFT_A, { status: 'completed' });
    for (const [fn, body] of [['notify-application-update', { application_id: APP_A, status: 'accepted' }], ['notify-shift-complete', { shift_id: SHIFT_A }], ['notify-matching-workers', { shift_id: SHIFT_A }]] as const) {
      load(fn); setShift(SHIFT_A, { status: fn === 'notify-matching-workers' ? 'open' : 'completed' });
      for (const who of [NOBODY, EMP2, WA, WB]) assert.equal(await status(call(fn, who, body)), 403, `${fn} as ${who}`);
    }
    load('notify-shift-complete');
    assert.equal(await status(call('notify-shift-complete', EMP, { shift_id: SHIFT_B })), 403, 'the right employer, but a valid shift from another business');
    assert.deepEqual(pushes, []);
  });

  test('5/15. another worker cannot impersonate the worker; the employer cannot report the worker\'s own action', async () => {
    load('notify-worker-checkin');
    assert.equal(await status(call('notify-worker-checkin', WB, { application_id: APP_A, event: 'checked_in' })), 403);
    assert.equal(await status(call('notify-worker-checkin', EMP, { application_id: APP_A, event: 'checked_in' })), 403);
    load('notify-shift-application');
    assert.equal(await status(call('notify-shift-application', WB, { application_id: APP_A })), 403);
    assert.deepEqual(pushes, []);
  });

  test('7. ID mixing: a valid shift, worker or business named in the body cannot lend authority to an application that is not theirs', async () => {
    load('notify-application-update');   // EMP owns SHIFT_A; APP_B belongs to EMP2's SHIFT_B
    assert.equal(await status(call('notify-application-update', EMP, { application_id: APP_B, status: 'accepted', shift_id: SHIFT_A, worker_id: WB, employer_id: EMP })), 403);
    load('notify-worker-checkin');       // WA is a real worker, but APP_B is WB's
    assert.equal(await status(call('notify-worker-checkin', WA, { application_id: APP_B, event: 'checked_in', shift_id: SHIFT_A, worker_id: WA })), 403);
    load('notify-collected'); setReq(REQ, { status: 'collected' });   // DRV is a real driver, but REQ_UNMATCHED has no run
    assert.equal(await status(call('notify-collected', DRV, { request_id: REQ_UNMATCHED, run_id: RUN, driver_id: DRV })), 403);
    assert.deepEqual(pushes, []);
  });

  test('9. the caller cannot supply a recipient: user_id, token, worker and driver lists in the body are ignored', async () => {
    const evil = { user_id: NOBODY, userId: NOBODY, recipient: NOBODY, recipients: [NOBODY], push_token: 'ExponentPushToken[x]', worker_ids: [NOBODY], driver_ids: [NOBODY], employer_id: NOBODY, customer_id: NOBODY };
    load('notify-shift-application'); await call('notify-shift-application', WA, { application_id: APP_A, ...evil });
    load('notify-worker-checkin'); await call('notify-worker-checkin', WA, { application_id: APP_A, event: 'checked_in', ...evil });
    load('notify-application-update'); await call('notify-application-update', EMP, { application_id: APP_A, status: 'accepted', ...evil });
    load('notify-shift-complete'); setShift(SHIFT_A, { status: 'completed' }); await call('notify-shift-complete', EMP, { shift_id: SHIFT_A, ...evil });
    load('notify-collected'); setReq(REQ, { status: 'collected' }); await call('notify-collected', DRV, { request_id: REQ, ...evil });
    load('notify-drivers'); await call('notify-drivers', CUST2, { request_id: REQ_UNMATCHED, ...evil });
    assert.ok(pushes.length >= 6);
    assert.ok(!pushes.some((p) => p.to.includes(NOBODY)), 'a body-supplied recipient received a push');
    const to = (cat: string) => pushes.find((p) => p.categoryId === cat)!.to;
    assert.deepEqual(to('shifts.new_application'), [EMP]);
    assert.deepEqual(to('shifts.worker_checked_in'), [EMP]);
    assert.deepEqual(to('shifts.application_accepted'), [WA]);
    assert.deepEqual(to('shifts.complete'), [WA]);
    assert.deepEqual(to('fetch.collected'), [CUST]);
    assert.deepEqual(to('fetch.new_request').sort(), [DRV, DRV2].sort());
  });

  test('10/12. the wrong customer, a driver, or an unassigned request cannot raise a Fetch notification', async () => {
    load('notify-drivers');
    for (const who of [CUST2, DRV, DRV2, NOBODY]) assert.equal(await status(call('notify-drivers', who, { request_id: REQ, event: 'cancelled' })), 403);
    setReq(REQ, { status: 'cancelled' });
    for (const who of [CUST2, DRV, NOBODY]) assert.equal(await status(call('notify-drivers', who, { request_id: REQ, event: 'cancelled' })), 403);
    load('notify-collected'); setReq(REQ, { status: 'collected' });
    for (const who of [CUST, DRV2, NOBODY]) assert.equal(await status(call('notify-collected', who, { request_id: REQ })), 403);
    assert.equal(await status(call('notify-collected', DRV, { request_id: REQ_UNMATCHED })), 403, 'a request no run has accepted');
    assert.deepEqual(pushes, []);
  });

  test('the claimed fact must be true: "confirmed" needs an accepted application, "complete" a completed shift, a check-in a recorded check-in, "collected" a collected parcel, "cancelled" a cancelled request', async () => {
    load('notify-application-update');
    assert.equal(await status(call('notify-application-update', EMP, { application_id: APP_A_PENDING, status: 'accepted' })), 409, 'still pending: no "You\'re confirmed" push');
    assert.equal(await status(call('notify-application-update', EMP, { application_id: APP_A, status: 'rejected' })), 409);
    assert.equal(await status(call('notify-application-update', EMP, { application_id: APP_A, status: 'banana' })), 400);
    load('notify-shift-complete'); assert.equal(await status(call('notify-shift-complete', EMP, { shift_id: SHIFT_A })), 409, 'the shift is still open');
    load('notify-worker-checkin');
    assert.equal(await status(call('notify-worker-checkin', WA, { application_id: APP_A, event: 'checked_out' })), 409, 'no check-out recorded');
    setApp(APP_A, { status: 'pending' });
    assert.equal(await status(call('notify-worker-checkin', WA, { application_id: APP_A, event: 'checked_in' })), 409, 'only an accepted application can check in');
    load('notify-collected'); assert.equal(await status(call('notify-collected', DRV, { request_id: REQ })), 409, 'still matched, not collected');
    load('notify-drivers');
    assert.equal(await status(call('notify-drivers', CUST, { request_id: REQ, event: 'cancelled' })), 409, 'not cancelled');
    assert.equal(await status(call('notify-drivers', CUST, { request_id: REQ })), 409, 'a matched request is not re-broadcast to the whole driver pool');
    load('notify-matching-workers'); setShift(SHIFT_A, { status: 'cancelled' });
    assert.equal(await status(call('notify-matching-workers', EMP, { shift_id: SHIFT_A })), 409, 'a cancelled shift is not advertised');
    assert.deepEqual(pushes, []);
  });

  test('13/14/16/17. shift application, completion, matching fan-out and application update each need the employer or worker of THAT shift/application', async () => {
    load('notify-matching-workers');
    assert.equal(await status(call('notify-matching-workers', EMP, { shift_id: SHIFT_A })), 200);
    const fan = pushes[0]; assert.ok(fan.to.includes(WA) && fan.to.includes(WB) && !fan.to.includes(EMP), 'the employer is not told about their own shift');
    pushes = [];
    load('notify-shift-complete'); setShift(SHIFT_B, { status: 'completed' });
    assert.equal(await status(call('notify-shift-complete', EMP2, { shift_id: SHIFT_B })), 200);
    assert.deepEqual(pushes[0].to, [WB]);
  });

  test('18. the existing rate limits are still claimed, with the same classes — and a throttled caller sends nothing', async () => {
    const classes: Record<string, string[]> = { 'notify-drivers': ['notify_broadcast', 'notify_any'] };
    for (const l of LEGIT) {
      seed(); load(l.fn); l.ready(); limiterCalls = [];
      await call(l.fn, l.as, l.body);
      assert.deepEqual(limiterCalls, [{ fn: l.fn, subject: `user:${l.as}`, classes: classes[l.fn] ?? ['notify_direct', 'notify_any'] }], l.fn);
    }
    pushes = []; limiterDeny = true;
    for (const l of LEGIT) { seed(); limiterDeny = true; load(l.fn); l.ready(); assert.equal(await status(call(l.fn, l.as, l.body)), 429, l.fn); }
    assert.deepEqual(pushes, []);
    limiterDeny = false; limiterCalls = [];
    load('notify-shift-complete'); setShift(SHIFT_A, { status: 'completed' });
    assert.equal(await status(call('notify-shift-complete', 'service', { shift_id: SHIFT_A })), 200);
    assert.deepEqual(limiterCalls, [], 'our own backend is not throttled');
  });

  test('19/20. build 147 and web request bodies work unchanged: no new field is required', async () => {
    const is147 = [
      ['notify-application-update', EMP, { application_id: APP_A, status: 'accepted' }, () => {}],             // lib/shifts-api.ts updateApplicationStatus
      ['notify-application-update', EMP, { application_id: APP_A_PENDING, status: 'rejected', reason: 'filled' }, () => setApp(APP_A_PENDING, { status: 'rejected' })], // …cascade when the shift fills
      ['notify-shift-application', WA, { application_id: APP_A }, () => {}],                                    // lib/shifts-api.ts applyToShift
      ['notify-worker-checkin', WA, { application_id: APP_A, event: 'checked_in' }, () => {}],                 // lib/shifts-api.ts checkIn
      ['notify-shift-complete', EMP, { shift_id: SHIFT_A }, () => setShift(SHIFT_A, { status: 'completed' })], // lib/shifts-api.ts confirmShiftComplete
      ['notify-matching-workers', EMP, { shift_id: SHIFT_A }, () => {}],                                        // components/shifts/ShiftPostForm.tsx
      ['notify-drivers', CUST2, { request_id: REQ_UNMATCHED }, () => {}],                                       // app/(customer)/request/step-4.tsx
      ['notify-drivers', CUST, { request_id: REQ, event: 'cancelled' }, () => setReq(REQ, { status: 'cancelled' })], // customer dashboard / request-detail (after cancel-payment)
      ['notify-collected', DRV, { request_id: REQ }, () => setReq(REQ, { status: 'collected' })],               // app/(driver)/dashboard.tsx, request-detail.tsx
    ] as const;
    for (const [fn, as, body, ready] of is147) { seed(); load(fn); ready(); pushes = []; assert.equal(await status(call(fn, as, body)), 200, `${fn} ${JSON.stringify(body)}`); assert.ok(pushes.length === 1, fn); }
    // web: the same bodies, plus the worker check-out event and the web employer shift-complete / application-update components
    load('notify-worker-checkin'); setApp(APP_A, { checked_out_at: '2026-10-08T16:00:00Z' }); pushes = [];
    assert.equal(await status(call('notify-worker-checkin', WA, { application_id: APP_A, event: 'checked_out' })), 200);
    load('notify-drivers'); pushes = [];     // components/fetch/RequestComposer.tsx sends { request_id } right after the request row is quoted
    assert.equal(await status(call('notify-drivers', CUST2, { request_id: REQ_UNMATCHED })), 200);
  });

  test('a service-role caller (our own backend) is still trusted', async () => {
    for (const l of LEGIT) { seed(); load(l.fn); l.ready(); pushes = []; assert.equal(await status(call(l.fn, 'service', l.body)), 200, l.fn); assert.equal(pushes.length, 1, l.fn); }
  });
});

describe('load-bearing: remove the authorisation call and every attack works again', () => {
  const byFn = new Map<string, typeof ATTACKS[number]>();
  for (const a of ATTACKS) if (!byFn.has(a.fn)) byFn.set(a.fn, a);
  for (const [fn, a] of byFn) {
    test(`${fn}: without authoriseXNotify, "${a.name}" succeeds`, async () => {
      load(fn, noDecision); a.ready?.();
      assert.equal(await status(call(fn, a.as, a.body)), 200);
      assert.ok(pushes.length > 0);
    });
  }
  test('and with it present the same request is refused (the control for the pair above)', async () => {
    for (const [fn, a] of byFn) { pushes = []; seed(); load(fn); a.ready?.(); assert.notEqual(await status(call(fn, a.as, a.body)), 200, fn); assert.deepEqual(pushes, [], fn); }
  });
});

describe('static: what the handlers read from the request, and who they authenticate', () => {
  const src = (fn: string) => readFileSync(join(REPO_ROOT, `supabase/functions/${fn}/index.ts`), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const READS: Record<string, string> = {
    'notify-application-update': 'application_id, status, reason', 'notify-shift-application': 'application_id', 'notify-worker-checkin': 'application_id, event',
    'notify-shift-complete': 'shift_id', 'notify-matching-workers': 'shift_id', 'notify-drivers': 'request_id, event', 'notify-collected': 'request_id',
  };
  for (const [fn, fields] of Object.entries(READS)) {
    test(`${fn} reads only { ${fields} } from the body, authenticates with requireCaller, and calls its authorisation gate before any lookup`, () => {
      const s = src(fn);
      assert.equal([...s.matchAll(/const \{([^}]*)\} = await req\.json\(\)/g)].map((m) => m[1].trim()).join(' | '), fields);
      assert.match(s, /requireCaller\(req, corsHeaders\)/); assert.doesNotMatch(s, /anonSupabase|auth\.getUser/);
      const gate = s.indexOf('const decision = await authorise'); const firstLookup = s.indexOf(".from('", s.indexOf('requireCaller(req'));
      assert.ok(gate > 0 && gate < firstLookup, 'the authorisation call must come before the first table read');
      assert.doesNotMatch(s, /userId:\s*(?:body|user_id|recipient)/);
    });
  }
  test('the two helpers resolve authority from the database and the authenticated caller only', () => {
    for (const h of ['shift-notify-auth', 'fetch-notify-auth']) {
      const s = readFileSync(join(REPO_ROOT, `supabase/functions/_shared/${h}.ts`), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      assert.match(s, /caller\.userId/); assert.doesNotMatch(s, /\.from\('(profiles)'\)/);
    }
  });
});
