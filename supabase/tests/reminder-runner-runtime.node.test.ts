/**
 * reminder-runner-runtime.node.test.ts — RUNTIME proof that the scheduled reminder job behaves correctly now that the shared sender fails closed.
 * Runs the REAL reminder-runner/index.ts + REAL send-push.ts + cron-auth.ts (see _support/load-reminder-runner.ts) against an in-memory database and a MOCK Expo.
 * ISOLATED: run by `npm run test:isolated` (needs PASS_PROOF_DSN): the delivery ledger (reminder_deliveries, migration 20261129090000) is the REAL one in the throwaway Postgres; nothing
 * here can reach Supabase, Expo or the internet (the mock refuses every other host). No physical device is involved: "sent" here means the MOCK
 * provider accepted a message.
 *
 * For each of the 11 reminder families: A accepted push is stamped | B an unreadable preference check sends nothing and is NOT stamped | C...so the next run
 * recovers it | D...exactly once (a third run sends nothing) | E opt-out is final (stamped, never re-asked) | F quiet hours is final (stamped, nothing sent: the
 * existing no-catch-up policy) | G no device and provider failure keep their original handling (stamped) | H a missing preferences row behaves as it always did.
 */
import { test, describe, before, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadReminderRunner, makeDb, resetLedgerDb, clearLedger, ledgerRows, type Mode } from './_support/load-reminder-runner.ts';
import { mockExpo } from './_support/load-send-push.ts';

const NOW = new Date('2026-11-02T19:00:00.000Z');   // 19:00 London (GMT): after every once-a-day gate
const TODAY = '2026-11-02';
const at = (mins: number) => new Date(NOW.getTime() + mins * 60_000).toISOString();
type Db = ReturnType<typeof makeDb>;
let R: Awaited<ReturnType<typeof loadReminderRunner>>; let db: Db; let expo: ReturnType<typeof mockExpo>;

const tok = (u: string) => `ExponentPushToken[${u}]`;
const device = (d: Db, u: string) => { d.table('push_tokens').push({ user_id: u, token: tok(u) }); d.table('profiles').push({ id: u, push_token: tok(u) }); };
const cfgStamped = (d: Db, key: string) => d.table('admin_config').some((r) => r.key === key && r.value === TODAY);

interface Family { name: string; counter: string; users: string[]; seed: (d: Db) => void; stamped: (d: Db) => boolean }
const FAMILIES: Family[] = [
  { name: 'delivery reminder (Fetch expiring)', counter: 'fetch_reminded', users: ['u1'],
    seed: (d) => d.table('delivery_requests').push({ id: 'r1', customer_id: 'u1', status: 'pending', reminder_sent_at: null, expires_at: at(60), category_slug: 'parcel' }),
    stamped: (d) => d.table('delivery_requests')[0].reminder_sent_at != null },
  { name: 'booking reminder (1 hour)', counter: 'booking_1h', users: ['u1'],
    seed: (d) => d.table('book_bookings').push({ id: 'b1', customer_id: 'u1', business_id: 'biz', status: 'confirmed', reminder_1h_sent_at: null, reminder_24h_sent_at: null, starts_at: at(60) }),
    stamped: (d) => d.table('book_bookings')[0].reminder_1h_sent_at != null && d.table('book_bookings')[0].reminder_24h_sent_at != null },
  { name: 'booking reminder (24 hours)', counter: 'booking_24h', users: ['u1'],
    seed: (d) => d.table('book_bookings').push({ id: 'b1', customer_id: 'u1', business_id: 'biz', status: 'confirmed', reminder_1h_sent_at: null, reminder_24h_sent_at: null, starts_at: at(600) }),
    stamped: (d) => d.table('book_bookings')[0].reminder_24h_sent_at != null },
  { name: 'event reminder (3 ticket holders)', counter: 'event_24h', users: ['h1', 'h2', 'h3'],
    seed: (d) => { d.table('events').push({ id: 'e1', title: 'Up Helly Aa', starts_at: at(600), reminder_sent_at: null }); for (const h of ['h1', 'h2', 'h3']) d.table('event_tickets').push({ event_id: 'e1', holder_id: h, status: 'valid' }); },
    stamped: (d) => d.table('events')[0].reminder_sent_at != null },
  { name: 'daily digest: Wird o\' da day', counter: 'daily_wird', users: ['u1'],
    seed: (d) => d.table('spik_dictionary').push({ id: 1, word: 'peerie', short_meaning: 'small', word_status: 'approved' }),
    stamped: (d) => cfgStamped(d, 'last_daily_wird_date') },
  { name: 'daily digest: cruise today', counter: 'cruise_today', users: ['u1'],
    seed: (d) => d.table('cruise_day_summary').push({ visit_date: TODAY, ships_count: 1, total_est_pax: 2000 }),
    stamped: (d) => cfgStamped(d, 'last_cruise_today_date') },
  { name: 'daily digest: streak nudge', counter: 'streak_nudge', users: ['u1'],
    seed: (d) => d.table('games_user_stats').push({ user_id: 'u1', current_streak_days: 3, last_played_date: '2026-11-01' }),
    stamped: (d) => cfgStamped(d, 'last_streak_nudge_date') },
  { name: 'loyalty: one more stamp', counter: 'loyalty_nudge', users: ['u1'],
    seed: (d) => d.table('local_loyalty_cards').push({ id: 'c1', user_id: 'u1', stamps_collected: 4, nudge_reminded_at: null, reward_reminded_at: 'x', program: { type: 'stamps', stamps_required: 5, stamp_reward: 'a coffee', is_active: true }, business: { name: 'Cafe' } }),
    stamped: (d) => d.table('local_loyalty_cards')[0].nudge_reminded_at !== null },
  { name: 'loyalty: reward waiting', counter: 'loyalty_reward', users: ['u1'],
    seed: (d) => d.table('local_loyalty_cards').push({ id: 'c1', user_id: 'u1', stamps_collected: 5, nudge_reminded_at: 'x', reward_reminded_at: null, program: { type: 'stamps', stamps_required: 5, stamp_reward: 'a coffee', is_active: true }, business: { name: 'Cafe' } }),
    stamped: (d) => d.table('local_loyalty_cards')[0].reward_reminded_at !== null },
  { name: 'pass expiring', counter: 'pass_expiring', users: ['u1'],
    seed: (d) => d.table('book_unit_purchases').push({ id: 'p1', owner_id: 'u1', uses_remaining: 2, refund_state: 'none', expiry_reminded_at: null, expires_at: at(24 * 60), business: { name: 'Gym' }, item: { name: '10-class pass' } }),
    stamped: (d) => d.table('book_unit_purchases')[0].expiry_reminded_at != null },
  { name: 'Fetch shop-order nudge (buyer + shop owner)', counter: 'fetch_orders_nudged', users: ['buyer', 'owner'],
    seed: (d) => { d.table('product_orders').push({ id: 'o1', buyer_id: 'buyer', business_id: 'biz', delivery_request_id: 'd1', fulfilment: 'fetch', fetch_nudged_at: null, paid_at: at(-3 * 24 * 60), status: 'paid' });
      d.table('delivery_requests').push({ id: 'd1', status: 'pending', expires_at: null }); d.table('local_businesses').push({ id: 'biz', name: 'Shop', owner_id: 'owner' }); },
    stamped: (d) => d.table('product_orders')[0].fetch_nudged_at != null },
];

const setup = (f: Family, mode: Mode = 'allow', devices = true) => { db = makeDb(); db.table('local_businesses').some((b) => b.id === 'biz') || db.table('local_businesses').push({ id: 'biz', name: 'Shop', owner_id: 'owner' }); f.seed(db); for (const u of f.users) { if (devices) device(db, u); db.setMode(u, mode); } };
const modeAll = (f: Family, m: Mode) => { for (const u of f.users) db.setMode(u, m); };

before(async () => { await resetLedgerDb(); R = await loadReminderRunner(); Object.assign(R.sendPush.preferenceCheckConfig, { attempts: 2, timeoutMs: 100, retryDelayMs: 1 }); });
beforeEach(async () => { await clearLedger(); mock.timers.enable({ apis: ['Date'], now: NOW }); expo = mockExpo(); expo.install(); });
afterEach(() => { expo.restore(); mock.timers.reset(); });

test('0 the runner refuses an unauthenticated call (cron secret) before touching anything', async () => { db = makeDb(); assert.equal(await R.runUnauthorised(), 401); assert.equal(db.calls.rpc.length, 0); });

for (const f of FAMILIES) describe(f.name, () => {
  test('A accepted: pushed through the real sender, counted and stamped', async () => {
    setup(f); const r = await R.run(db);
    assert.equal(r.status, 200); assert.ok(r.json[f.counter] >= 1, JSON.stringify(r.json)); assert.equal(f.stamped(db), true);
    assert.equal(expo.sent.length, f.users.length === 3 ? 3 : f.users.length); assert.equal(r.json.deferred_preference_check, 0);
  });
  test('B-D unreadable preference check: nothing sent, NOT stamped; next run recovers it; third run sends nothing more (no duplicate)', async () => {
    setup(f, 'error'); const r1 = await R.run(db);
    assert.equal(expo.sent.length, 0, 'a failed check must send nothing'); assert.equal(f.stamped(db), false, 'a failed check must not mark the reminder as sent');
    assert.ok(r1.json.deferred_preference_check >= 1); assert.equal(r1.json[f.counter], 0);
    modeAll(f, 'allow'); const r2 = await R.run(db);                                       // recovery
    assert.equal(expo.sent.length, f.users.length, 'recovered exactly once per recipient'); assert.equal(f.stamped(db), true); assert.ok(r2.json[f.counter] >= 1); assert.equal(r2.json.deferred_preference_check, 0);
    await R.run(db); assert.equal(expo.sent.length, f.users.length, 'a third run must not duplicate');
  });
  test('B2 a check that THROWS behaves the same as one that errors', async () => {
    setup(f, 'throw'); await R.run(db); assert.equal(expo.sent.length, 0); assert.equal(f.stamped(db), false);
  });
  test('E explicit opt-out is final: nothing sent, stamped, never re-asked on later runs', async () => {
    setup(f, 'optout'); const r1 = await R.run(db); assert.equal(expo.sent.length, 0); assert.equal(f.stamped(db), true); assert.equal(r1.json.deferred_preference_check, 0);
    const asked = db.calls.should_notify.length; await R.run(db); await R.run(db);
    assert.equal(db.calls.should_notify.length, asked, 'an opted-out recipient is not retried as if the failure were temporary'); assert.equal(expo.sent.length, 0);
  });
  test('F quiet hours: nothing sent; existing policy retained (stamped, no catch-up); urgent was never used to override it', async () => {
    setup(f, 'quiet'); await R.run(db); assert.equal(expo.sent.length, 0); assert.equal(f.stamped(db), true);
    assert.ok(db.calls.should_notify.every((c) => c.mode === 'quiet'));
    assert.equal(expo.sent.length, 0, 'the sender re-asks with urgent only to NAME the reason; it never sends');
  });
  test('G1 no device token: nothing sent, original handling (stamped)', async () => { setup(f, 'allow', false); await R.run(db); assert.equal(expo.sent.length, 0); assert.equal(f.stamped(db), true); });
  test('G2 provider failure: original handling kept (stamped, never counted as accepted-by-device beyond the mock)', async () => {
    setup(f); expo.restore(); expo = mockExpo(Object.fromEntries(f.users.map((u) => [tok(u), 'error' as const]))); expo.install();
    const r = await R.run(db); assert.equal(f.stamped(db), true); assert.equal(r.json.deferred_preference_check, 0); assert.equal(r.status, 200);
  });
  test('H missing preferences row = production default (enabled): behaves exactly like an explicit allow', async () => {
    setup(f, 'missing'); await R.run(db); assert.equal(expo.sent.length, f.users.length); assert.equal(f.stamped(db), true);
  });
});

describe('partial outcomes (bulk and two-sided families)', () => {
  const ev = FAMILIES.find((f) => f.name.startsWith('event'))!; const fo = FAMILIES.find((f) => f.name.startsWith('Fetch shop-order'))!;
  test('P1 event: one holder unreadable, two reachable -> the two are sent ONCE; the event stays open for the third; recovery sends only the third; no duplicate row', async () => {
    setup(ev); db.setMode('h1', 'error'); const r = await R.run(db);
    assert.deepEqual(expo.sent.map((m) => m.to).sort(), [tok('h2'), tok('h3')]); assert.equal(ev.stamped(db), false, 'the event is not complete while a holder is retryable'); assert.ok(r.json.deferred_preference_check >= 1);
    assert.deepEqual((await ledgerRows()).map((x) => `${x.user}:${x.status}`).sort(), ['h1:check_failed', 'h2:sent', 'h3:sent']);
    modeAll(ev, 'allow'); await R.run(db); assert.deepEqual(expo.sent.map((m) => m.to).sort(), [tok('h1'), tok('h2'), tok('h3')], 'only h1 was added'); assert.equal(ev.stamped(db), true);
    await R.run(db); assert.equal(expo.sent.length, 3); assert.deepEqual((await ledgerRows()).map((x) => `${x.user}:${x.status}`).sort(), ['h1:sent', 'h2:sent', 'h3:sent']);
  });
  test('P2 event: all three unreadable -> nothing sent, unstamped; recovery sends three once', async () => {
    setup(ev, 'error'); await R.run(db); assert.equal(expo.sent.length, 0); assert.equal(ev.stamped(db), false);
    modeAll(ev, 'allow'); await R.run(db); await R.run(db); assert.equal(expo.sent.length, 3);
  });
  test('P3 event: mix of opt-out, unreadable and allowed -> opt-out never gets a push; unreadable one is not pushed', async () => {
    setup(ev); db.setMode('h1', 'optout'); db.setMode('h2', 'error'); await R.run(db);
    assert.deepEqual(expo.sent.map((m) => m.to), [tok('h3')]);
  });
  test('P4 shop-order nudge: buyer unreadable but shop owner reachable -> owner sent once; order stays open for the buyer; recovery sends only the buyer', async () => {
    setup(fo); db.setMode('buyer', 'error'); await R.run(db); assert.deepEqual(expo.sent.map((m) => m.to), [tok('owner')]); assert.equal(fo.stamped(db), false);
    modeAll(fo, 'allow'); await R.run(db); assert.deepEqual(expo.sent.map((m) => m.to), [tok('owner'), tok('buyer')]); assert.equal(fo.stamped(db), true);
    await R.run(db); assert.equal(expo.sent.length, 2);
  });
  test('P5 shop-order nudge: both unreadable -> unstamped; recovers once', async () => {
    setup(fo, 'error'); await R.run(db); assert.equal(fo.stamped(db), false); modeAll(fo, 'allow'); await R.run(db); await R.run(db); assert.equal(expo.sent.length, 2);
  });
  test('P6 overlapping scheduled runs after a deferral never duplicate (second run sees the stamp)', async () => {
    const f = FAMILIES[1]; setup(f, 'error'); await R.run(db); modeAll(f, 'allow'); await R.run(db); await R.run(db); assert.equal(expo.sent.length, 1);
  });
});

describe('bulk result fields and latency', () => {
  test('R1 sendUserPushBulk: sent / skipped / errored / checkFailed add up and a failed check is never "sent"', async () => {
    db = makeDb(); for (const u of ['a', 'b', 'c', 'd', 'e']) device(db, u); db.setMode('b', 'optout'); db.setMode('c', 'quiet'); db.setMode('d', 'error'); db.setMode('e', 'throw');
    const r = await R.sendPush.sendUserPushBulk(db.client, ['a', 'b', 'c', 'd', 'e'], { module: 'events', categoryId: 'events.reminder', title: 't', body: 'b' } as never);
    assert.deepEqual(r, { sent: 1, skipped: 2, errored: 2, checkFailed: 2 }); assert.deepEqual(expo.sent.map((m) => m.to), [tok('a')]);
  });
  test('R2 latency: 300 recipients whose check fails fast finish well inside a runner pass (default retry timing unchanged: 2 attempts, 250 ms)', async () => {
    Object.assign(R.sendPush.preferenceCheckConfig, { attempts: 2, timeoutMs: 4000, retryDelayMs: 250 });
    try {
      db = makeDb(); const ids = Array.from({ length: 300 }, (_, i) => `u${i}`); for (const u of ids) { device(db, u); db.setMode(u, 'error'); }
      const t0 = performance.now(); const r = await R.sendPush.sendUserPushBulk(db.client, ids, { module: 'events', categoryId: 'events.reminder', title: 't', body: 'b' } as never);
      const ms = performance.now() - t0; assert.equal(r.checkFailed, 300); assert.equal(expo.sent.length, 0); assert.ok(ms < 2500, `took ${ms.toFixed(0)} ms`);
      assert.equal(db.calls.should_notify.length, 600, 'exactly two attempts per recipient, no unbounded retry');
    } finally { Object.assign(R.sendPush.preferenceCheckConfig, { attempts: 2, timeoutMs: 100, retryDelayMs: 1 }); }
  });
});
