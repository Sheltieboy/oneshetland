/**
 * transactional-notifications.node.test.ts
 *
 * notifications-transactional: the launch standard is not "everything notifies" — it is that money moving
 * back to a customer is never silent, that each event reaches the right person once through a durable
 * record, and that no notification channel can break the transaction it reports. Real source runs here
 * against fakes (Supabase, Expo, Stripe, env); nothing is sent, fetched or written.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadModule, readRepo, REPO_ROOT } from './_support/load-source.ts';

type Row = Record<string, any>;

/* ── a tiny chainable fake for supabase-js ───────────────────────────────── */

function builder(rowsOrFn: any) {
  const rows = () => (typeof rowsOrFn === 'function' ? rowsOrFn() : rowsOrFn);
  const one = () => { const r = rows(); return Array.isArray(r) ? (r[0] ?? null) : (r ?? null); };
  const q: any = {};
  for (const m of ['select', 'eq', 'neq', 'gte', 'in', 'is', 'limit', 'order', 'or']) q[m] = () => q;
  q.maybeSingle = async () => ({ data: one(), error: null });
  q.single = async () => ({ data: one(), error: null });
  q.then = (res: any, rej: any) => Promise.resolve({ data: Array.isArray(rows()) ? rows() : (rows() ? [rows()] : []), error: null, count: 0 }).then(res, rej);
  return q;
}

function fakeDb(tables: Record<string, any>, rpcs: Record<string, any> = {}, userId = 'caller-1') {
  return {
    auth: { getUser: async () => ({ data: { user: userId ? { id: userId } : null } }) },
    from: (t: string) => (tables[t] === undefined ? builder([]) : builder(tables[t])),
    rpc: async (name: string) => ({ data: typeof rpcs[name] === 'function' ? rpcs[name]() : (rpcs[name] ?? null), error: null }),
  };
}

const ORDER_ID = '11111111-1111-1111-1111-111111111111';
let env: Record<string, string | undefined>;
let pushes: Row[];
let pushThrows: boolean;
let priorNotifications: Row[];
let stripeCalls: string[];

beforeEach(() => {
  env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's', STRIPE_SECRET_KEY: 'sk_test_x' };
  pushes = []; pushThrows = false; priorNotifications = []; stripeCalls = [];
  (globalThis as any).Deno = { env: { get: (k: string) => env[k] } };
  (globalThis as any).fetch = async (url: string, init: any) => {
    stripeCalls.push(`${init?.method ?? 'GET'} ${url.replace('https://api.stripe.com/v1', '')}`);
    if (url.includes('/payment_intents/')) return { ok: true, status: 200, json: async () => ({
      // a genuine ticket payment: what create-event-ticket-intent stamps on it (refund-payment now refuses anything else)
      status: 'succeeded', amount: 1500, currency: 'gbp',
      metadata: { type: 'event_tickets', order_id: ORDER_ID, event_id: 'ev1', buyer_id: 'buyer-1' },
      latest_charge: { id: 'ch_1', refunded: false, amount_refunded: 0, transfer: 'tr_1' },
    }) };
    if (url.endsWith('/refunds')) return { ok: true, status: 200, json: async () => ({ id: 're_1', amount: 1500 }) };
    if (url.includes('/reversals')) return { ok: true, status: 200, json: async () => ({ id: 'trr_1' }) };
    throw new Error('unexpected fetch ' + url);
  };
});

const sendUserPushStub = async (_svc: any, input: Row) => {
  if (pushThrows) throw new Error('push exploded');
  pushes.push(input);
  return { status: 'sent' };
};
const noticeModule = () => loadModule('supabase/functions/_shared/refund-notice.ts', {
  'https://esm.sh/@supabase/supabase-js@2': {}, './send-push.ts': { sendUserPush: sendUserPushStub },
});
const noticeDb = () => ({ from: () => builder(() => priorNotifications) }) as any;

/* ── the refund notice helper ────────────────────────────────────────────── */

describe('refund notice', () => {
  test('wallet refund says it is back in the Wallet now; card refund says it takes days', () => {
    const { refundCopy } = noticeModule();
    const w = refundCopy({ amountPence: 1500, what: 'Your tickets for Up Helly Aa', destination: 'wallet' });
    assert.equal(w.title, '£15.00 refunded to your Wallet');
    assert.match(w.body, /back in your OneShetland Wallet now/);
    const c = refundCopy({ amountPence: 250, what: 'Your tickets for X', destination: 'card' });
    assert.equal(c.title, '£2.50 refunded to your card');
    assert.match(c.body, /5–10 working days/);
  });

  test('it goes to the customer, through the Wallet module, with a deep link and a stable key', async () => {
    const r = await noticeModule().notifyRefund(noticeDb(), { userId: 'buyer-1', refundKey: 'event_order:abc', amountPence: 1500, what: 'x', destination: 'wallet', data: { screen: 'local-wallet' } });
    assert.equal(r, 'sent');
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].userId, 'buyer-1');
    assert.equal(pushes[0].module, 'wallet');
    assert.equal(pushes[0].categoryId, 'wallet.refunded');
    assert.deepEqual(pushes[0].data, { screen: 'local-wallet', refund_key: 'event_order:abc' });
  });

  test('NO DUPLICATES: the same refunded thing is announced once', async () => {
    priorNotifications = [{ id: 'n1' }];
    const r = await noticeModule().notifyRefund(noticeDb(), { userId: 'buyer-1', refundKey: 'event_order:abc', amountPence: 1500, what: 'x', destination: 'card' });
    assert.equal(r, 'duplicate');
    assert.equal(pushes.length, 0);
  });

  test('nothing to announce: no recipient, zero or invalid amount', async () => {
    const { notifyRefund } = noticeModule();
    for (const bad of [{ userId: null, amountPence: 100 }, { userId: 'u', amountPence: 0 }, { userId: 'u', amountPence: NaN }, { userId: 'u', amountPence: -5 }]) {
      assert.equal(await notifyRefund(noticeDb(), { ...bad, refundKey: 'k', what: 'x', destination: 'wallet' } as any), 'skipped');
    }
    assert.equal(pushes.length, 0);
  });

  test('PUSH FAILURE ISOLATION: a throwing sender is swallowed — the refund is never undone or blocked', async () => {
    pushThrows = true;
    const r = await noticeModule().notifyRefund(noticeDb(), { userId: 'u', refundKey: 'k', amountPence: 100, what: 'x', destination: 'wallet' });
    assert.equal(r, 'failed');
  });

  test('a failed duplicate-check lookup is also swallowed', async () => {
    const boom = { from: () => { throw new Error('db down'); } } as any;
    assert.equal(await noticeModule().notifyRefund(boom, { userId: 'u', refundKey: 'k', amountPence: 100, what: 'x', destination: 'wallet' }), 'failed');
  });
});

/* ── the real refund handlers ────────────────────────────────────────────── */

describe('event-ticket refund (refund-payment)', () => {
  let handler: (r: Request) => Promise<Response>;

  function load(order: Row) {
    const notice = noticeModule();
    const svc = fakeDb({
      event_ticket_orders: order, profiles: { role: 'user', is_platform_owner: false },
      events: { title: 'Up Helly Aa' }, hub_membership_purchases: null, notification_log: () => priorNotifications,
    }, { can_refund_event_orders: true, refund_event_tickets_for_payment: { action: 'refunded' } }, 'organiser-9');
    loadModule('supabase/functions/refund-payment/index.ts', {
      'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: any) => { handler = h; } },
      'https://esm.sh/@supabase/supabase-js@2': { createClient: () => svc },
      '../_shared/safe-error.ts': { safeError: (_n: string, e: any) => String(e?.message ?? e) },
      '../_shared/refund-reconcile.ts': {
        reconcileCharge: async () => ({ state: 'ok', note: '' }), reconcileWalletOrder: async () => ({ state: 'ok', note: '' }),
      },
      '../_shared/event-wallet-refund-core.ts': {
        isWalletRef: (s: string) => String(s).startsWith('wallet_'),
        refundWalletEventOrder: async () => ({ ok: true, amount_pence: 1500, merchant_reversed: true, already_reversed: false, tickets_action: 'refunded' }),
      },
      '../_shared/refund-notice.ts': notice,
      '../_shared/ticket-payment-binding.ts': loadModule('supabase/functions/_shared/ticket-payment-binding.ts', {}),
    });
  }
  const refund = () => handler(new Request('https://x/refund-payment', { method: 'POST', headers: { Authorization: 'Bearer t' }, body: JSON.stringify({ event_order_id: ORDER_ID }) }));
  const cardOrder = { id: ORDER_ID, event_id: 'ev1', buyer_id: 'buyer-1', status: 'paid', total_pence: 1500, stripe_payment_intent_id: 'pi_123', refunded_at: null };
  const walletOrder = { ...cardOrder, stripe_payment_intent_id: 'wallet_aaaa' };

  test('card refund: the BUYER (not the organiser who pressed refund) is told, and told it takes days', async () => {
    load(cardOrder);
    const res = await refund();
    assert.equal(res.status, 200);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].userId, 'buyer-1');
    assert.notEqual(pushes[0].userId, 'organiser-9', 'no cross-account leakage to the person refunding');
    assert.match(pushes[0].title, /£15\.00 refunded to your card/);
    assert.match(pushes[0].body, /Up Helly Aa/);
    assert.deepEqual(pushes[0].data, { screen: 'my-event-tickets', order_id: ORDER_ID, refund_key: `event_order:${ORDER_ID}` });
    assert.ok(stripeCalls.some((c) => c.startsWith('POST /refunds')));
  });

  test('wallet refund: the buyer is told the money is back in the Wallet — and no Stripe refund is attempted', async () => {
    load(walletOrder);
    const res = await refund();
    assert.equal(res.status, 200);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].userId, 'buyer-1');
    assert.match(pushes[0].title, /£15\.00 refunded to your Wallet/);
    assert.equal(stripeCalls.length, 0);
  });

  test('a repeat of the same refund cannot announce twice', async () => {
    load(cardOrder);
    await refund();
    priorNotifications = [{ id: 'already' }];
    await refund();
    assert.equal(pushes.length, 1);
  });

  test('PUSH FAILURE ISOLATION: the refund still succeeds when the notification throws', async () => {
    load(cardOrder); pushThrows = true;
    const res = await refund();
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.ok, true);
    assert.equal(out.refund_id, 're_1');
  });

  test('a refused refund (not paid) notifies nobody', async () => {
    load({ ...cardOrder, status: 'refunded' });
    const res = await refund();
    assert.equal(res.status, 400);
    assert.equal(pushes.length, 0);
  });
});

describe('merchant Wallet refund (wallet-refund-business)', () => {
  let handler: (r: Request) => Promise<Response>;
  let finalise: Row;

  function load(txn: Row | null) {
    const svc = fakeDb({
      local_wallet_transactions: txn, local_businesses: { id: 'b1', name: 'Hay & Co', owner_id: 'caller-1' },
      profiles: { role: 'user' }, notification_log: () => priorNotifications,
    }, { business_refund_claim: { ok: true, outcome: 'claimed' }, business_refund_finalise: () => finalise });
    loadModule('supabase/functions/wallet-refund-business/index.ts', {
      'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: any) => { handler = h; } },
      'https://esm.sh/@supabase/supabase-js@2': { createClient: () => svc },
      '../_shared/safe-error.ts': { safeError: (_n: string, e: any) => String(e?.message ?? e) },
      '../_shared/rate-limit.ts': { enforceRateLimit: async () => ({}), userSubject: (u: string) => u },
      '../_shared/refund-notice.ts': noticeModule(),
    });
  }
  const txn = { id: 'tx-1', user_id: 'customer-7', business_id: 'b1', type: 'spend', amount_pence: -850, transfer_state: 'none', stripe_transfer_id: null, description: 'Pass' };
  const refund = () => handler(new Request('https://x/wallet-refund-business', { method: 'POST', headers: { Authorization: 'Bearer t' }, body: JSON.stringify({ transaction_id: 'tx-1' }) }));
  beforeEach(() => { finalise = { ok: true, balance_pence: 2000 }; });

  test('the CUSTOMER is told, naming the business and the amount, linking to the Wallet', async () => {
    load(txn);
    const res = await refund();
    assert.equal(res.status, 200);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].userId, 'customer-7');
    assert.notEqual(pushes[0].userId, 'caller-1', 'the merchant who pressed Refund is not the recipient');
    assert.equal(pushes[0].title, '£8.50 refunded to your Wallet');
    assert.match(pushes[0].body, /Your payment to Hay & Co/);
    assert.equal(pushes[0].data.screen, 'local-wallet');
  });

  test('retrying a finished refund (already_complete) still announces — and the dedupe makes it once', async () => {
    finalise = { ok: true, already_complete: true };
    load(txn);
    await refund();
    assert.equal(pushes.length, 1);
    priorNotifications = [{ id: 'x' }];
    await refund();
    assert.equal(pushes.length, 1);
  });

  test('a refused refund notifies nobody', async () => {
    finalise = { ok: false, error: 'nope' };
    load(txn);
    const res = await refund();
    assert.equal(res.status, 409);
    assert.equal(pushes.length, 0);
  });

  test('PUSH FAILURE ISOLATION: money has moved, so the merchant still gets success when the notice throws', async () => {
    load(txn); pushThrows = true;
    const res = await refund();
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });
});

/* ── Notification Centre persistence and push failure isolation ──────────── */

describe('shared push sender → durable Notification Centre record', () => {
  let logRows: Row[];
  let tokens: string[];
  let muted: boolean;
  let expo: { ok: boolean; body: Row } | 'throw';
  let deleted: string[];

  const supa = () => ({
    rpc: async () => ({ data: !muted, error: null }),
    from: (t: string) => {
      if (t === 'push_tokens') return {
        select: () => ({ eq: async () => ({ data: tokens.map((token) => ({ token })) }) }),
        delete: () => ({ eq: async (_c: string, v: string) => { deleted.push(v); return {}; } }),
      };
      if (t === 'profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { push_token: null } }) }) }), update: () => ({ eq: () => ({ eq: async () => ({}) }) }) };
      if (t === 'notification_log') return { insert: async (row: Row) => { logRows.push(row); return {}; } };
      throw new Error('unexpected table ' + t);
    },
  }) as any;

  function sender() {
    logRows = []; deleted = []; tokens = ['ExponentPushToken[abc]']; muted = false; expo = { ok: true, body: { data: { status: 'ok' } } };
    (globalThis as any).fetch = async (url: string) => {
      assert.equal(url, 'https://exp.host/--/api/v2/push/send');
      if (expo === 'throw') throw new Error('expo unreachable');
      return { ok: expo.ok, json: async () => expo.body };
    };
    return loadModule('supabase/functions/_shared/send-push.ts', { 'https://esm.sh/@supabase/supabase-js@2': { createClient: () => ({}) } }).sendUserPush as
      (s: any, i: Row) => Promise<any>;
  }
  const input = { userId: 'u1', module: 'wallet', categoryId: 'wallet.refunded', title: 'T', body: 'B', data: { screen: 'local-wallet' } };

  test('a delivered push writes one inbox row for that user, with the deep-link data', async () => {
    const r = await sender()(supa(), input);
    assert.equal(r.status, 'sent');
    assert.equal(logRows.length, 1);
    assert.deepEqual([logRows[0].user_id, logRows[0].category, logRows[0].status], ['u1', 'wallet.refunded', 'sent']);
    assert.deepEqual(logRows[0].data, { screen: 'local-wallet' });
  });

  test('NO TOKEN: still a durable inbox row (a push is never the only record)', async () => {
    const s = sender(); tokens = [];
    const r = await s(supa(), input);
    assert.equal(r.status, 'no_token');
    assert.equal(logRows.length, 1);
    assert.equal(logRows[0].status, 'no_token');
  });

  test('Expo failure: recorded as an error, never thrown', async () => {
    const s = sender(); expo = { ok: false, body: { data: { status: 'error', message: 'boom' } } };
    const r = await s(supa(), input);
    assert.equal(r.status, 'error');
    assert.equal(logRows[0].status, 'error');
  });

  test('network failure: recorded, never thrown', async () => {
    const s = sender(); expo = 'throw';
    assert.equal((await s(supa(), input)).status, 'error');
  });

  test('a dead device token is pruned so we stop sending to it', async () => {
    const s = sender(); expo = { ok: false, body: { data: { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } } } };
    await s(supa(), input);
    assert.deepEqual(deleted, ['ExponentPushToken[abc]']);
  });

  test('a user who muted the module gets no push, and the row is the hidden opt-out kind', async () => {
    const s = sender(); muted = true;
    const r = await s(supa(), input);
    assert.equal(r.status, 'skipped_pref');
    assert.equal(logRows[0].status, 'skipped_pref');
  });

  test('the inbox shows sent / no_token / skipped_quiet and hides opt-outs and errors', () => {
    const inbox = readRepo('lib/notifications-inbox.ts');
    const m = inbox.match(/VISIBLE_STATUSES = \[([^\]]+)\]/)!;
    const shown = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    assert.deepEqual(shown, ['no_token', 'sent', 'skipped_quiet']);
  });
});

describe('Notification Centre — ownership and write access', () => {
  const allSql = () => readdirSync(join(REPO_ROOT, 'supabase', 'migrations')).map((n) => readRepo(`supabase/migrations/${n}`)).join('\n');

  test('users can read only their own rows, and no policy lets a client insert, update or delete', () => {
    const sql = allSql();
    assert.match(sql, /CREATE POLICY "Users see their own notification log" ON public\.notification_log FOR SELECT USING \(\(user_id = auth\.uid\(\)\)\)/);
    assert.doesNotMatch(sql, /CREATE POLICY[^;]*ON public\.notification_log FOR (INSERT|UPDATE|DELETE|ALL)/i);
  });

  test('the inbox RPCs act on auth.uid() only', () => {
    const sql = allSql();
    for (const fn of ['unread_notification_count', 'mark_notifications_read']) {
      const m = sql.match(new RegExp(`FUNCTION public\\.${fn}[\\s\\S]*?\\$\\$;`, 'i'));
      assert.ok(m, fn);
      assert.match(m![0], /auth\.uid\(\)/);
    }
  });

  test('should_notify (reveals another user\'s mute settings) is service-role only', () => {
    const mig = readRepo('supabase/migrations/20261031000000_should_notify_service_only.sql').replace(/^\s*--.*$/gm, '');
    assert.match(mig, /revoke execute on function public\.should_notify\(uuid, text, boolean\) from public, anon, authenticated/);
    assert.match(mig, /grant\s+execute on function public\.should_notify\(uuid, text, boolean\) to service_role/);
  });

  test('every caller of the push sender uses the service role (so the preference check can never fail open)', () => {
    const FUNCS = join(REPO_ROOT, 'supabase', 'functions');
    const walk = (d: string, acc: string[] = []): string[] => {
      for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p, acc); else if (n.endsWith('.ts') && !n.endsWith('.test.ts')) acc.push(p); }
      return acc;
    };
    for (const f of walk(FUNCS)) {
      if (f.includes('/_shared/')) continue;
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/sendUserPush(?:Bulk)?\(\s*([A-Za-z_]\w*)/g)) {
        for (const d of src.matchAll(new RegExp(`(?:const|let)\\s+${m[1]}\\s*(?::[^=]+)?=\\s*(?:await\\s+)?(createClient|createServiceClient)\\(([\\s\\S]{0,260}?)\\)\\s*;`, 'g'))) {
          assert.ok(d[1] === 'createServiceClient' || /SERVICE_ROLE/.test(d[2]), `${f}: ${m[1]} is not a service-role client`);
        }
      }
    }
  });
});

/* ── the launch notification standard, as a coverage table ───────────────── */

describe('MUST-notify events are covered; nothing else is switched on by accident', () => {
  const FUNCS = 'supabase/functions';
  const has = (file: string, needle: string | RegExp) => {
    const src = readRepo(`${FUNCS}/${file}`);
    return typeof needle === 'string' ? src.includes(needle) : needle.test(src);
  };

  const MUST: Array<[string, string, string]> = [
    ['event ticket refund (card + Wallet)', 'refund-payment/index.ts', "destination: 'card'"],
    ['event ticket refund (Wallet)', 'refund-payment/index.ts', "destination: 'wallet'"],
    ['merchant Wallet refund', 'wallet-refund-business/index.ts', 'notifyRefund'],
    ['Wallet membership refund', 'refund-payment/index.ts', 'membership:${m.id}'],
    ['card membership refund', 'stripe-webhook/index.ts', 'hubs.membership_refunded'],
    ['delivery refund', 'stripe-webhook/index.ts', 'fetch.refunded'],
    ['Wallet top-up', 'local-wallet-confirm-topup/index.ts', 'wallet.topup'],
    ['Wallet spend', '_shared/wallet-pay.ts', 'wallet.payment'],
    ['pass / unit purchase', 'confirm-unit-purchase/index.ts', 'wallet.purchase'],
    ['hub donation', 'confirm-hub-donation/index.ts', 'hubs.donation_receipt'],
    ['gift purchased', 'confirm-gift/index.ts', 'wallet.gift_sent'],
    ['booking cancelled by the other party', 'notify-booking/index.ts', 'bookings.cancelled'],
    ['event cancelled', 'notify-event-update/index.ts', 'events.cancelled'],
    ['product order moved / refunded', 'notify-product-order/index.ts', 'refunded:'],
    ['business plan ended / lapsed', 'stripe-webhook/index.ts', 'business.subscription_lapsed'],
    ['failed delivery payment', 'stripe-webhook/index.ts', 'fetch.payment_failed'],
  ];
  for (const [event, file, needle] of MUST) test(`covered: ${event}`, () => assert.ok(has(file, needle), `${file} should contain ${String(needle)}`));

  test('ticket receipt email is sent from every path that can mark an order paid', () => {
    for (const f of ['create-event-ticket-intent/index.ts', 'confirm-event-tickets/index.ts', '_shared/fulfilment.ts']) {
      assert.ok(has(f, 'sendTicketReceipt'), f);
    }
    assert.ok(has('_shared/ticket-receipt.ts', /events\.tickets_confirmed[\s\S]*order_id/), 'idempotent on the order');
  });

  test('the set of emails actually wired is exactly the reviewed set — dormant templates stay dormant', () => {
    const FUNCS_DIR = join(REPO_ROOT, 'supabase', 'functions');
    const keys = new Set<string>();
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.ts') && !n.endsWith('.test.ts')) {
      const src = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const m of src.matchAll(/templateKey:\s*(?:cancelled \? )?'([a-z_.]+)'(?: : '([a-z_.]+)')?/g)) { keys.add(m[1]); if (m[2]) keys.add(m[2]); }
    } } };
    walk(FUNCS_DIR);
    assert.deepEqual([...keys].sort(), [
      'account.password_reset', 'billing.plan_active', 'billing.plan_ended', 'events.cancelled', 'events.tickets_confirmed',
      'events.update', 'local.gift_received', 'local.gift_verify_recipient',
    ]);
  });

  test('the booking, welcome, security and receipt templates are NOT sent (decided: in-app record is enough for now)', () => {
    const all = ['local.booking_confirmed', 'local.booking_cancelled', 'local.booking_reminder', 'account.welcome', 'security.new_signin',
      'security.password_changed', 'security.email_changed', 'local.wallet_topup', 'local.subscription_receipt', 'platform.newsletter'];
    const FUNCS_DIR = join(REPO_ROOT, 'supabase', 'functions');
    const walk = (d: string): string => readdirSync(d).map((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : (n.endsWith('.ts') && !n.endsWith('.test.ts') ? readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '') : ''); }).join('\n');
    const src = walk(FUNCS_DIR);
    for (const k of all) assert.ok(!src.includes(`'${k}'`), `${k} is wired — review it before enabling`);
  });

  test('no excessive fan-out: a refund sends exactly one notification per refunded thing', () => {
    const src = readRepo(`${FUNCS}/refund-payment/index.ts`);
    assert.equal((src.match(/await notifyRefund\(/g) ?? []).length, 3, 'event-wallet, event-card, wallet-membership — one each');
    assert.equal((readRepo(`${FUNCS}/wallet-refund-business/index.ts`).match(/await notifyRefund\(/g) ?? []).length, 1);
  });

  test('deep links used by the new notices exist in the app router', () => {
    const nav = readRepo('lib/notifications.ts');
    assert.match(nav, /'my-event-tickets':\s+'\/my-event-tickets'/);
    assert.match(nav, /'local-wallet':\s+'\/local-wallet'/);
  });
});
