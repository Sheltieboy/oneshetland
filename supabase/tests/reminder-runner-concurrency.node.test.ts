/**
 * reminder-runner-concurrency.node.test.ts — the claim ledger, proven with the REAL reminder-runner, the REAL sender, a MOCK Expo and a REAL Postgres (isolated).
 * Several runner executions run AT THE SAME TIME (independent psql connections, genuinely interleaved), and workers are "killed" at chosen points by a hook that throws.
 * Persistent state (reminder_deliveries) is read back from the database. A MOCK provider accepting a message is not proof a handset received it.
 *
 * RECOVERY POLICY (chosen to prevent duplicate pushes, documented in docs/notices-member-notifications.md):
 *   crash BEFORE the provider was contacted  -> the lease expires and the next run sends it (nothing was ever sent)
 *   crash AFTER dispatch began, outcome unrecorded -> 'uncertain': NEVER resent (a missed reminder beats a duplicate; delivery in that window is genuinely unknowable)
 */
import { test, describe, before, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadReminderRunner, makeDb, resetLedgerDb, clearLedger, ledgerRows, psql, uuidOf } from './_support/load-reminder-runner.ts';
import { mockExpo } from './_support/load-send-push.ts';

const NOW = new Date('2026-11-02T19:00:00.000Z'); const TODAY = '2026-11-02';
const at = (mins: number) => new Date(NOW.getTime() + mins * 60_000).toISOString();
type Db = ReturnType<typeof makeDb>;
let R: Awaited<ReturnType<typeof loadReminderRunner>>; let expo: ReturnType<typeof mockExpo>;
const tok = (u: string) => `ExponentPushToken[${u}]`;
const device = (d: Db, u: string) => { d.table('push_tokens').push({ user_id: u, token: tok(u) }); d.table('profiles').push({ id: u, push_token: tok(u) }); };
const states = async () => (await ledgerRows()).map((r) => `${r.family}/${r.user}:${r.status}`).sort();
const crash = (what: string) => async () => { throw new Error(`CRASH ${what}`); };

before(async () => { await resetLedgerDb(); R = await loadReminderRunner(); Object.assign(R.sendPush.preferenceCheckConfig, { attempts: 2, timeoutMs: 100, retryDelayMs: 1 }); });
beforeEach(async () => { await clearLedger(); mock.timers.enable({ apis: ['Date'], now: NOW }); expo = mockExpo(); expo.install(); });
afterEach(() => { expo.restore(); mock.timers.reset(); });

const eventDb = (holders: string[]) => { const d = makeDb(); d.table('events').push({ id: 'e1', title: 'Up Helly Aa', starts_at: at(600), reminder_sent_at: null, status: 'published' }); for (const h of holders) { d.table('event_tickets').push({ event_id: 'e1', holder_id: h, status: 'valid' }); device(d, h); } return d; };
const bookingDb = (mins = 60, n = 1) => { const d = makeDb(); for (let i = 0; i < n; i++) { d.table('book_bookings').push({ id: `b${i}`, customer_id: `c${i}`, business_id: 'biz', status: 'confirmed', reminder_1h_sent_at: null, reminder_24h_sent_at: null, starts_at: at(mins) }); device(d, `c${i}`); } return d; };

describe('simultaneous runner executions send each reminder once', () => {
  for (const n of [2, 3]) test(`${n} simultaneous runs: booking reminders (5 bookings) go out exactly once each, recorded once each`, async () => {
    const d = bookingDb(60, 5); await Promise.all(Array.from({ length: n }, () => R.run(d)));
    assert.equal(expo.sent.length, 5, `sent ${expo.sent.length}`); assert.equal(new Set(expo.sent.map((m) => m.to)).size, 5);
    assert.equal((await ledgerRows("family = 'booking_1h' and status = 'sent'")).length, 5); assert.ok(d.table('book_bookings').every((b) => b.reminder_1h_sent_at));
  });
  for (const n of [2, 3]) test(`${n} simultaneous runs: an event with 8 ticket holders sends 8 pushes, one per holder`, async () => {
    const holders = Array.from({ length: 8 }, (_, i) => `h${i}`); const d = eventDb(holders); await Promise.all(Array.from({ length: n }, () => R.run(d)));
    assert.equal(expo.sent.length, 8); assert.equal(new Set(expo.sent.map((m) => m.to)).size, 8); assert.equal((await ledgerRows("status = 'sent'")).length, 8); assert.ok(d.table('events')[0].reminder_sent_at);
  });
  test('3 simultaneous runs: every other family is sent once (delivery, daily digests, loyalty, pass, Fetch order)', async () => {
    const d = makeDb(); for (const u of ['u1', 'owner', 'buyer', 'p1']) device(d, u);
    d.table('delivery_requests').push({ id: 'r1', customer_id: 'u1', status: 'pending', reminder_sent_at: null, expires_at: at(60), category_slug: 'parcel' }, { id: 'd1', status: 'pending', expires_at: null });
    d.table('spik_dictionary').push({ id: 1, word: 'peerie', short_meaning: 'small', word_status: 'approved' });
    d.table('local_loyalty_cards').push({ id: 'c1', user_id: 'u1', stamps_collected: 4, nudge_reminded_at: null, reward_reminded_at: 'x', program: { type: 'stamps', stamps_required: 5, stamp_reward: 'coffee', is_active: true }, business: { name: 'Cafe' } },
      { id: 'c2', user_id: 'owner', stamps_collected: 5, nudge_reminded_at: 'x', reward_reminded_at: null, program: { type: 'stamps', stamps_required: 5, stamp_reward: 'tea', is_active: true }, business: { name: 'Cafe' } });
    d.table('book_unit_purchases').push({ id: 'pp', owner_id: 'p1', uses_remaining: 2, refund_state: 'none', expiry_reminded_at: null, expires_at: at(24 * 60), business: { name: 'Gym' }, item: { name: 'pass' } });
    d.table('product_orders').push({ id: 'o1', buyer_id: 'buyer', business_id: 'biz', delivery_request_id: 'd1', fulfilment: 'fetch', fetch_nudged_at: null, paid_at: at(-3 * 24 * 60), status: 'paid' }); d.table('local_businesses').push({ id: 'biz', name: 'Shop', owner_id: 'owner' });
    d.table('games_user_stats').push({ user_id: 'u1', current_streak_days: 3, last_played_date: '2026-11-01' });
    await Promise.all([R.run(d), R.run(d), R.run(d)]);
    const per = (cat: string) => expo.sent.filter((m) => m.categoryId === cat).length;
    assert.equal(per('fetch.expiring'), 1); assert.equal(per('loyalty.almost_there'), 1); assert.equal(per('loyalty.reward_ready'), 1); assert.equal(per('wallet.pass_expiring'), 1);
    assert.equal(per('wallet.order_update'), 1); assert.equal(per('business.order'), 1); assert.equal(per('games.streak'), 1); assert.equal(per('spik.daily_wird'), 4);   // wird goes to every device user (u1, owner, buyer, p1)
    const dup = await psql(`select count(*) from (select family, subject_id, user_id from reminder_deliveries group by 1,2,3 having count(*) > 1) x`); assert.equal(dup, '0');
  });
  test('an expired delivery request is flipped and notified by exactly one of three simultaneous runs', async () => {
    const d = makeDb(); device(d, 'u1'); d.table('delivery_requests').push({ id: 'r9', customer_id: 'u1', status: 'pending', reminder_sent_at: null, expires_at: at(-5), category_slug: 'parcel' });
    await Promise.all([R.run(d), R.run(d), R.run(d)]); assert.equal(expo.sent.filter((m) => m.categoryId === 'fetch.expired').length, 1); assert.equal(d.table('delivery_requests')[0].status, 'expired');
  });
});

describe('partial event delivery and recovery (the persistent ledger)', () => {
  test('three eligible holders: two receive it, one has a temporary preference error; recovery retries only the third; the first two never get a second push; no duplicate row', async () => {
    const d = eventDb(['h1', 'h2', 'h3']); d.setMode('h3', 'error');
    await R.run(d); assert.deepEqual(expo.sent.map((m) => m.to).sort(), [tok('h1'), tok('h2')]);
    assert.deepEqual(await states(), ['event_24h/h1:sent', 'event_24h/h2:sent', 'event_24h/h3:check_failed']); assert.equal(d.table('events')[0].reminder_sent_at, null);
    d.setMode('h3', 'allow'); const r2 = await R.run(d);
    assert.deepEqual(expo.sent.map((m) => m.to).sort(), [tok('h1'), tok('h2'), tok('h3')]); assert.deepEqual(await states(), ['event_24h/h1:sent', 'event_24h/h2:sent', 'event_24h/h3:sent']);
    assert.ok(d.table('events')[0].reminder_sent_at); assert.equal(r2.json.deferred_preference_check, 0);
    await R.run(d); await R.run(d); assert.equal(expo.sent.length, 3); assert.equal((await ledgerRows()).length, 3);
    const att = await ledgerRows(); assert.deepEqual(att.map((r) => `${r.user}:${r.attempts}`).sort(), ['h1:1', 'h2:1', 'h3:2']);
  });
  test('every recipient outcome is recorded distinctly: sent / opted_out / quiet_hours / no_device / provider_error / check_failed', async () => {
    const hs = ['s', 'o', 'q', 'n', 'p', 'c']; const d = eventDb(hs); d.setMode('o', 'optout'); d.setMode('q', 'quiet'); d.setMode('c', 'error');
    d.table('push_tokens').splice(d.table('push_tokens').findIndex((t) => t.user_id === 'n'), 1); d.table('profiles').find((p) => p.id === 'n')!.push_token = null;
    expo.restore(); expo = mockExpo({ [tok('p')]: 'error' }); expo.install(); await R.run(d);
    const m = Object.fromEntries((await ledgerRows()).map((r) => [r.user, r.status])); assert.deepEqual(m, { s: 'sent', o: 'opted_out', q: 'quiet_hours', n: 'no_device', p: 'provider_error', c: 'check_failed' });
  });
  test('only genuinely retryable failures are retried: opted-out, quiet, no-device and provider-failed holders are never re-asked or re-sent on later runs', async () => {
    const d = eventDb(['o', 'q', 'p', 'c']); d.setMode('o', 'optout'); d.setMode('q', 'quiet'); d.setMode('c', 'error'); expo.restore(); expo = mockExpo({ [tok('p')]: 'error' }); expo.install();
    await R.run(d); const asked = (u: string) => d.calls.should_notify.filter((x) => x.user === u).length; const before = { o: asked('o'), q: asked('q'), p: asked('p') };
    await R.run(d); await R.run(d); assert.deepEqual({ o: asked('o'), q: asked('q'), p: asked('p') }, before); assert.equal(expo.sent.length, 1, 'only the provider-failed holder was ever attempted (and not again)');
  });
  test('retry is bounded: a holder whose check keeps failing is attempted at most 12 times, then left final; the event is then closed (no endless runs)', async () => {
    const d = eventDb(['h1', 'h2']); d.setMode('h2', 'error'); for (let i = 0; i < 14; i++) await R.run(d);
    assert.equal((await ledgerRows("user_id = '" + uuidOf('h2') + "'"))[0].attempts, 12); assert.ok(d.table('events')[0].reminder_sent_at, 'closed once the attempts are used up'); assert.equal(expo.sent.length, 1);
  });
});

describe('deadlines: nothing is sent after the reminder stops being relevant', () => {
  test('a booking that has started, an event that has begun and a delivery that has expired are not reminded; a claim at the deadline is refused by the database itself', async () => {
    const d = bookingDb(-5, 1); d.table('events').push({ id: 'e1', title: 'x', starts_at: at(-5), reminder_sent_at: null, status: 'published' }); await R.run(d); assert.equal(expo.sent.length, 0);
    const out = JSON.parse(await psql(`select jsonb_agg(to_jsonb(t)) from reminder_claim_many('event_24h','e2', array['${uuidOf('z')}']::uuid[], 600, '${at(-1)}'::timestamptz, 12, null, '${at(0)}'::timestamptz) t`));
    assert.equal(out[0].r_state, 'expired'); assert.equal(out[0].r_token, null); assert.equal((await ledgerRows("subject_id = 'e2'")).length, 0, 'no row is even created past the deadline');
  });
  test('a retry that arrives after the event has started is refused: the failed holder is not reminded after the event begins', async () => {
    const d = eventDb(['h1', 'h2']); d.setMode('h2', 'error'); await R.run(d); assert.equal(expo.sent.length, 1);
    d.setMode('h2', 'allow'); d.table('events')[0].starts_at = at(-1); await R.run(d); assert.equal(expo.sent.length, 1, 'the events query no longer selects it');
    const out = JSON.parse(await psql(`select jsonb_agg(to_jsonb(t)) from reminder_claim_many('event_24h','e1', array['${uuidOf('h2')}']::uuid[], 600, '${at(-1)}'::timestamptz, 12, null, '${at(0)}'::timestamptz) t`));
    assert.equal(out[0].r_state, 'expired');
  });
  test('daily digests carry a deadline of the end of the London day', async () => {
    const d = makeDb(); device(d, 'u1'); d.table('games_user_stats').push({ user_id: 'u1', current_streak_days: 3, last_played_date: '2026-11-01' }); d.setMode('u1', 'error'); await R.run(d);
    mock.timers.setTime(new Date('2026-11-03T00:30:00.000Z').getTime());   // after midnight: a NEW London day. Yesterday's digest is never completed late.
    d.setMode('u1', 'allow'); await R.run(d); assert.equal(expo.sent.filter((m) => m.categoryId === 'games.streak').length, 0, 'before 18:00 on the new day nothing is due');
    const y = await ledgerRows("subject_id = '2026-11-02'"); assert.equal(y[0].status, 'check_failed');
  });
});

describe('interrupted workers (crashes) never duplicate a push and never block a reminder indefinitely', () => {
  test('crash BEFORE the claim: nothing is recorded; the next run sends it once', async () => {
    const d = bookingDb(60, 1); d.hooks.before = { reminder_claim_many: crash('before claim') }; const r1 = await R.run(d); assert.equal(r1.status, 500); assert.equal(expo.sent.length, 0); assert.equal((await ledgerRows()).length, 0);
    d.hooks.before = {}; await R.run(d); assert.equal(expo.sent.length, 1); assert.deepEqual(await states(), ['booking_1h/c0:sent']);
  });
  test('crash AFTER the claim, BEFORE dispatch: the lease blocks others for its duration, then the next run sends it ONCE (nothing had been sent)', async () => {
    const d = bookingDb(60, 1); d.hooks.after = { reminder_claim_many: crash('after claim') }; await R.run(d); assert.equal(expo.sent.length, 0); assert.deepEqual(await states(), ['booking_1h/c0:claimed']);
    d.hooks.after = {}; await R.run(d); assert.equal(expo.sent.length, 0, 'the live lease protects against a worker that is merely slow'); assert.equal(d.table('book_bookings')[0].reminder_1h_sent_at, null);
    mock.timers.tick(11 * 60_000); await R.run(d); assert.equal(expo.sent.length, 1); assert.deepEqual(await states(), ['booking_1h/c0:sent']); await R.run(d); assert.equal(expo.sent.length, 1);
  });
  test('crash AFTER the provider accepted but BEFORE the outcome was recorded: marked UNCERTAIN, never resent (duplicate prevention); the reminder is then closed', async () => {
    const d = bookingDb(60, 1); d.hooks.before = { reminder_finish_many: crash('before record') }; const r1 = await R.run(d); assert.equal(r1.status, 500); assert.equal(expo.sent.length, 1); assert.deepEqual(await states(), ['booking_1h/c0:dispatching']);
    d.hooks.before = {}; await R.run(d); assert.equal(expo.sent.length, 1, 'a dispatching row inside its lease is not touched');
    mock.timers.tick(11 * 60_000); await R.run(d); assert.equal(expo.sent.length, 1, 'NEVER resent'); assert.deepEqual(await states(), ['booking_1h/c0:uncertain']); assert.ok(d.table('book_bookings')[0].reminder_1h_sent_at, 'closed so it is not re-scanned forever');
  });
  test('crash AFTER the outcome was recorded but before the parent was stamped: the next run stamps it WITHOUT sending again', async () => {
    const d = bookingDb(60, 1); d.hooks.after = { reminder_finish_many: crash('after record') }; await R.run(d); assert.equal(expo.sent.length, 1); assert.equal(d.table('book_bookings')[0].reminder_1h_sent_at, null);
    d.hooks.after = {}; await R.run(d); assert.equal(expo.sent.length, 1); assert.ok(d.table('book_bookings')[0].reminder_1h_sent_at);
  });
  test('crash MID-BATCH (30 holders, outcomes recorded per 25): the first 25 stay done; the interrupted 5 are uncertain; a rerun sends nobody twice', async () => {
    const hs = Array.from({ length: 30 }, (_, i) => `h${String(i).padStart(2, '0')}`); const d = eventDb(hs); let n = 0; d.hooks.before = { reminder_finish_many: async () => { if (++n === 2) throw new Error('CRASH mid batch'); } };
    const r1 = await R.run(d); assert.equal(r1.status, 500); assert.equal(expo.sent.length, 30);
    const st = (await ledgerRows()).reduce((a: Record<string, number>, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {}); assert.deepEqual(st, { sent: 25, dispatching: 5 });
    d.hooks.before = {}; mock.timers.tick(11 * 60_000); await R.run(d); assert.equal(expo.sent.length, 30, 'nobody is sent twice'); assert.equal((await ledgerRows("status = 'uncertain'")).length, 5); assert.ok(d.table('events')[0].reminder_sent_at);
  });
  test('a slow worker that wakes AFTER its claim was reclaimed cannot send: its token no longer matches', async () => {
    const u = uuidOf('slow'); const a = JSON.parse(await psql(`select jsonb_agg(to_jsonb(t)) from reminder_claim_many('x','s', array['${u}']::uuid[], 30, null, 12, null, '${at(0)}'::timestamptz) t`))[0];
    const b = JSON.parse(await psql(`select jsonb_agg(to_jsonb(t)) from reminder_claim_many('x','s', array['${u}']::uuid[], 30, null, 12, null, '${at(1)}'::timestamptz) t`))[0];
    assert.equal(a.r_state, 'claimed'); assert.equal(b.r_state, 'claimed'); assert.notEqual(a.r_token, b.r_token);
    assert.equal(await psql(`select reminder_mark_dispatching('x','s','${u}','${a.r_token}', 30, '${at(1)}'::timestamptz)`), 'f'); assert.equal(await psql(`select reminder_mark_dispatching('x','s','${u}','${b.r_token}', 30, '${at(1)}'::timestamptz)`), 't');
  });
});

describe('the ledger itself (real PostgreSQL)', () => {
  test('N parallel claimers for the same recipient: exactly one gets the token', async () => {
    const u = uuidOf('race'); const rs = await Promise.all(Array.from({ length: 12 }, () => psql(`select r_state from reminder_claim_many('race','s', array['${u}']::uuid[], 600, null, 12, null, '${at(0)}'::timestamptz)`)));
    assert.equal(rs.filter((x) => x === 'claimed').length, 1); assert.equal(rs.filter((x) => x === 'in_progress').length, 11);
  });
  test('no client role can read or call the ledger', async () => {
    for (const role of ['anon', 'authenticated']) {
      assert.match(await psql(`set role ${role}; select count(*) from reminder_deliveries`).catch((e) => String(e.stderr)), /permission denied/);
      assert.match(await psql(`set role ${role}; select reminder_purge()`).catch((e) => String(e.stderr)), /permission denied/);
    }
  });
  test('reminder_finish_many rejects an unknown outcome; purge keeps in-flight rows and removes only old finished ones', async () => {
    assert.match(await psql(`select reminder_finish_many('a','b','[{"user":"${uuidOf('q')}","token":"${uuidOf('t')}","status":"wibble"}]'::jsonb)`).catch((e) => String(e.stderr)), /Unknown outcome/);
    await psql(`insert into reminder_deliveries (family, subject_id, user_id, status, updated_at) values ('f','old','${uuidOf('o1')}','sent', now() - interval '30 days'), ('f','oldc','${uuidOf('o2')}','claimed', now() - interval '30 days'), ('f','new','${uuidOf('o3')}','sent', now())`);
    assert.equal(await psql(`select reminder_purge()`), '1'); assert.deepEqual((await ledgerRows()).map((r) => r.subject_id).sort(), ['new', 'oldc']);
  });
  test('the loyalty "reuse after" re-arm: a finished row is reusable only after the interval (so a card that fills again can be nudged again, but an overlapping run cannot repeat it)', async () => {
    const u = uuidOf('card'); const c = (m: number) => psql(`select r_state from reminder_claim_many('loyalty_nudge','c1', array['${u}']::uuid[], 600, null, 12, interval '1 hour', '${at(m)}'::timestamptz)`);
    assert.equal(await c(0), 'claimed'); await psql(`select reminder_finish_many('loyalty_nudge','c1', jsonb_build_array(jsonb_build_object('user','${u}','token',(select claim_token from reminder_deliveries where subject_id='c1'),'status','sent')), '${at(0)}'::timestamptz)`);
    assert.equal(await c(5), 'sent'); assert.equal(await c(61), 'claimed');
  });
  test('ledger unavailable: the runner sends NOTHING (fails closed) and says so', async () => {
    const d = bookingDb(60, 1); d.hooks.before = { reminder_claim_many: async () => { throw new Error('connection refused'); } }; const r = await R.run(d);
    assert.equal(expo.sent.length, 0); assert.ok(r.json.ledger_error || r.status === 500);
  });
});
