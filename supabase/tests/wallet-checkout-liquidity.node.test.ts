/**
 * wallet-checkout-liquidity.node.test.ts
 *
 * Three Wallet-funded merchant-settlement routes in `wallet-checkout` — hub donation,
 * hub membership and pass purchase — debited the customer and only THEN asked Stripe
 * to move money to the merchant, with no check that the platform could fund it. The
 * canonical gate already guards till charges, product orders, event tickets and gifts.
 * Every wallet-checkout route now spends through settleMerchantWalletPayment, which
 * puts the shared gate in front of the debit.
 *
 * This runs the REAL wallet-checkout handler, the REAL wallet-ledger (claim / debit /
 * transfer / reverse), the REAL settlement core and the REAL gate core. Only the edges
 * are fakes: an in-memory database, Stripe's transfers endpoint, and a model of the
 * pooled Stripe balance (the same model wallet-liquidity-gate.node.test.ts uses for
 * the atomic reservation).
 *
 * It proves, for EACH of donation, membership and pass:
 *   · Critical liquidity refuses BEFORE the debit — no ledger spend, no transfer, no
 *     commerce row, no compensating refund, no attempt left behind — with the calm
 *     "Wallet temporarily unavailable … No money has been taken" answer
 *   · the same reference can then be paid once liquidity is healthy
 *   · healthy: exactly one debit and one transfer, to the right destination, for the
 *     right amount (the transfer, not the customer's total, is what is reserved)
 *   · retry and double-tap safety, an unreadable Stripe fails closed, the reservation
 *     is released after success AND failure
 * and across rails: simultaneous spends share one pool and cannot oversubscribe it.
 *
 * No Stripe, no database, no money, no service key.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';
import {
  runWithLiquidityGate, type GateDeps, type GateSnapshot, type GateReservation,
} from '../functions/_shared/wallet-liquidity-gate-core.ts';
import {
  WALLET_UNAVAILABLE_NO_CHARGE, WALLET_UNAVAILABLE_RESUMING,
} from '../functions/_shared/wallet-settlement-core.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

(globalThis as any).Deno ??= { env: { get: (k: string) => ({ STRIPE_SECRET_KEY: 'sk_test_FAKE', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'ANON', SUPABASE_SERVICE_ROLE_KEY: 'SERVICE' } as Record<string, string>)[k] } };

const USER = 'u-1111';
const HUB = 'hub-1', BIZ = 'biz-1', CAMPAIGN = 'camp-1', TIER = 'tier-1', ITEM = 'item-1';
const ACCT_HUB = 'acct_HUB', ACCT_BIZ = 'acct_BIZ_RESOLVED';

/* ── the pooled Stripe balance, and the gate's atomic reservation ──────────── */

class Pool implements GateDeps {
  held = 0; peakHeld = 0;
  snapshotCalls = 0;
  reserved: number[] = [];
  released: (string | null)[] = [];
  private n = 0;
  private amounts: Record<string, number> = {};
  status: GateSnapshot['status']; available: number; floor: number;
  constructor(status: GateSnapshot['status'], available: number, floor: number) {
    this.status = status; this.available = available; this.floor = floor;
  }
  async snapshot(): Promise<GateSnapshot> {
    this.snapshotCalls++;
    return { status: this.status, available_pence: this.available, reserve_pence: this.floor, error: this.status === 'unknown' ? 'stripe unreachable' : undefined };
  }
  async reserve(amount: number, available: number, floor: number): Promise<GateReservation> {
    // atomic: no await between the check and the claim, exactly like the lock-serialised RPC
    if (available - floor - this.held < amount) return { ok: false, heldPence: this.held };
    this.held += amount; this.peakHeld = Math.max(this.peakHeld, this.held);
    this.reserved.push(amount);
    const id = `res-${++this.n}`; this.amounts[id] = amount;
    return { ok: true, reservationId: id };
  }
  async release(id: string | null) { this.released.push(id); if (id) this.held -= this.amounts[id] ?? 0; }
}

/* ── the world: an in-memory database and Stripe ──────────────────────────── */

type Row = Record<string, any>;
class World {
  balance = 50_000;
  ledger: Row[] = [];
  claims = new Map<string, Row>();
  idem = new Map<string, Row>();
  transfers: { amount: number; destination: string; key: string; body: URLSearchParams; heldAtCall: number }[] = [];
  reversals: string[] = [];
  donations: Row[] = []; memberships: Row[] = []; passes: Row[] = []; boosts: Row[] = []; failed: Row[] = [];
  debitCalls = 0;
  stripeMode: 'ok' | 'reject' = 'ok';
  transferDelayMs = 0;
  selfPay: ((userId: string, acct: string) => Promise<{ status: number; body: Record<string, unknown> } | null>) | null = null;
  claimCalls = 0;
  pool!: Pool;
  private tx = 0;

  tables: Record<string, Row | null> = {
    hubs: { id: HUB, name: 'North Isles Hub', stripe_account_id: ACCT_HUB, payout_enabled: true, is_charity: false, charity_number: null },
    hub_membership_types: { id: TIER, hub_id: HUB, name: 'Member', price_pence: 1000, period: 'year', is_active: true },
    book_unit_items: { id: ITEM, name: '5-visit pass', business_id: BIZ, price_pence: 2000, stock: null, is_active: true, uses_per_purchase: 5, valid_days: 90 },
    // Carries BOTH ways of finding the business's account (its own, and the canonical resolver's, which is the
    // same account here), so these tests hold whether or not the payout-resolver edit is in the file under test.
    local_businesses: { id: BIZ, name: 'Anderson & Co', stripe_account_id: ACCT_BIZ, payout_enabled: true },
  };

  svc() { return makeClient(this); }
  nextTx() { return `tx-${++this.tx}`; }
}

function makeClient(w: World) {
  const q = (table: string) => {
    const f: { op: 'select' | 'insert' | 'update' | 'delete'; eq: Record<string, unknown>; is: Record<string, unknown>; payload?: Row } = { op: 'select', eq: {}, is: {} };
    const run = () => {
      if (table === 'wallet_payment_claims' && f.op === 'delete') {
        const c = w.claims.get(String(f.eq.client_request_id));
        const ok = c && c.user_id === f.eq.user_id && c.status === f.eq.status && (f.is.wallet_transaction_id === null ? c.wallet_transaction_id == null : true);
        if (ok) w.claims.delete(String(f.eq.client_request_id));
        return { data: ok ? [{ client_request_id: f.eq.client_request_id }] : [], error: null };
      }
      if (table === 'local_wallet_transactions') {
        const r = w.ledger.find((x) => x.id === f.eq.id);
        return { data: r ? { transfer_state: r.transfer_state } : null, error: null };
      }
      if (table === 'book_unit_purchases' && f.op === 'insert') {
        const dup = w.passes.find((p) => p.payment_intent_id === f.payload!.payment_intent_id);
        if (dup) return { data: null, error: { message: 'duplicate' } };
        const row = { id: `pass-${w.passes.length + 1}`, ...f.payload };
        w.passes.push(row);
        return { data: { id: row.id, uses_remaining: row.uses_remaining, expires_at: row.expires_at }, error: null };
      }
      if (table === 'failed_fulfilments' && f.op === 'insert') { w.failed.push(f.payload!); return { data: null, error: null }; }
      return { data: w.tables[table] ?? null, error: null };
    };
    const b: any = {
      select: () => b,
      eq: (k: string, v: unknown) => { f.eq[k] = v; return b; },
      is: (k: string, v: unknown) => { f.is[k] = v; return b; },
      in: () => b, order: () => b, limit: () => b,
      insert: (p: Row) => { f.op = 'insert'; f.payload = p; return b; },
      update: (p: Row) => { f.op = 'update'; f.payload = p; return b; },
      delete: () => { f.op = 'delete'; return b; },
      single: async () => run(),
      maybeSingle: async () => run(),
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  };

  const rpcImpl: Record<string, (a: any) => any> = {
    claim_wallet_attempt: (a) => {
      w.claimCalls++;
      const cur = w.claims.get(a.p_request_id);
      if (!cur) { w.claims.set(a.p_request_id, { user_id: a.p_user, fingerprint: a.p_fingerprint, status: 'in_flight', wallet_transaction_id: null, result: null }); return { outcome: 'claimed', status: 'in_flight', wallet_transaction_id: null, result: null }; }
      if (cur.user_id !== a.p_user || cur.fingerprint !== a.p_fingerprint) return { outcome: 'conflict', status: cur.status, wallet_transaction_id: null, result: null };
      if (['completed', 'reversed', 'failed'].includes(cur.status)) return { outcome: 'replay', status: cur.status, wallet_transaction_id: cur.wallet_transaction_id, result: cur.result };
      if (cur.status === 'unresolved') return { outcome: 'resume', status: cur.status, wallet_transaction_id: cur.wallet_transaction_id, result: cur.result };
      return { outcome: 'in_flight', status: cur.status, wallet_transaction_id: cur.wallet_transaction_id, result: cur.result };
    },
    settle_wallet_attempt: (a) => {
      const c = w.claims.get(a.p_request_id);
      if (c && c.status !== 'completed') { c.status = a.p_status; c.wallet_transaction_id = a.p_txn ?? c.wallet_transaction_id; c.result = a.p_result ?? c.result; }
      return !!c;
    },
    wallet_debit_with_ledger: (a) => {
      w.debitCalls++;
      const prior = a.p_idempotency_key ? w.idem.get(a.p_idempotency_key) : undefined;
      if (prior) return { balance_pence: w.balance, transaction_id: prior.id, already_applied: true, insufficient: false };
      if (w.balance < a.p_spend) return { balance_pence: w.balance, transaction_id: null, already_applied: false, insufficient: true };
      w.balance -= a.p_spend;
      const row = { id: w.nextTx(), user_id: a.p_user, type: 'spend', amount_pence: -a.p_spend, platform_fee_pence: a.p_platform_fee, business_id: a.p_business, transfer_state: a.p_needs_transfer ? 'pending' : 'none', stripe_transfer_id: null, idempotency_key: a.p_idempotency_key };
      w.ledger.push(row); if (a.p_idempotency_key) w.idem.set(a.p_idempotency_key, row);
      return { balance_pence: w.balance, transaction_id: row.id, already_applied: false, insufficient: false };
    },
    wallet_mark_transfer: (a) => { const r = w.ledger.find((x) => x.id === a.p_transaction_id); if (r) { r.transfer_state = a.p_state; r.stripe_transfer_id = a.p_transfer_id ?? r.stripe_transfer_id; } return null; },
    wallet_reverse_debit: (a) => {
      const orig = w.ledger.find((x) => x.id === a.p_transaction_id);
      const already = w.ledger.some((x) => x.type === 'refund' && x.reverses === a.p_transaction_id);
      if (orig && !already) { w.balance += -orig.amount_pence; w.ledger.push({ id: w.nextTx(), type: 'refund', amount_pence: -orig.amount_pence, reverses: orig.id, user_id: orig.user_id }); orig.transfer_state = a.p_merchant === 'never_paid' || a.p_merchant === 'no_transfer' ? 'none' : (a.p_merchant === 'clawed_back' ? 'reversed' : 'unresolved'); }
      return { balance_pence: w.balance, reversal_id: 'rev', already_reversed: already };
    },
    campaign_donation_eligibility: () => [{ eligible: true, reason: 'ok', campaign_id: CAMPAIGN, hub_id: HUB }],
    record_hub_donation: (a) => { if (!w.donations.some((d) => d.p_pi === a.p_pi)) w.donations.push(a); return null; },
    activate_hub_membership: (a) => { if (!w.memberships.some((m) => m.p_pi === a.p_pi)) w.memberships.push(a); return { member_no: 7, paid_until: '2027-10-02' }; },
    business_payout_destination: () => [{ account_id: ACCT_BIZ }],
    loyalty_award_for_wallet_spend: () => null,
    shift_boost_eligibility: () => [{ eligible: true, reason: 'ok', employer_id: USER }],
    grant_wallet_shift_boost: (a) => { w.boosts.push(a); return { boosted_until: '2026-10-03T10:00:00Z' }; },
  };
  const ACCT_BIZ_LOCAL = ACCT_BIZ; void ACCT_BIZ_LOCAL;

  const rpc = (name: string, args: any) => {
    const res = rpcImpl[name] ? { data: rpcImpl[name](args), error: null } : { data: null, error: { message: `unexpected rpc ${name}` } };
    const o: any = { maybeSingle: async () => ({ data: Array.isArray(res.data) ? res.data[0] ?? null : res.data, error: res.error }), then: (r: any, j: any) => Promise.resolve(res).then(r, j) };
    return o;
  };
  return { from: q, rpc };
}

/** Fake Stripe: POST /v1/transfers (+ reversals). Everything else is not used by these routes. */
function installStripe(w: World) {
  (globalThis as any).fetch = async (url: string, init: any) => {
    const body = new URLSearchParams(String(init?.body ?? ''));
    if (/\/v1\/transfers$/.test(url)) {
      w.transfers.push({ amount: Number(body.get('amount')), destination: String(body.get('destination')), key: init.headers['Idempotency-Key'], body, heldAtCall: w.pool.held });
      if (w.transferDelayMs) await new Promise((r) => setTimeout(r, w.transferDelayMs));
      if (w.stripeMode === 'reject') return { ok: false, status: 400, json: async () => ({ error: { message: 'Insufficient funds in your Stripe account' } }) };
      return { ok: true, status: 200, json: async () => ({ id: `tr_${w.transfers.length}` }) };
    }
    if (/\/reversals$/.test(url)) { w.reversals.push(url); return { ok: true, status: 200, json: async () => ({ id: 'trr_1' }) }; }
    throw new Error(`unexpected Stripe call ${url}`);
  };
}

/* ── load the REAL code under test, with fakes only at the edges ──────────── */

const SB = { 'https://esm.sh/@supabase/supabase-js@2': {} };
const noReexport = (s: string) => s.replace(/^export \{[^}]*\} from '[^']+';?\s*$/gm, '');
const sourcePath = (n: string) => `supabase/functions/_shared/${n}.ts`;

let world: World;
const realLedger = loadModule(sourcePath('wallet-ledger'), SB, noReexport);
const ledger = { ...realLedger, selfPaymentBlock: (svc: unknown, userId: string, acct: string) => (world.selfPay ? world.selfPay(userId, acct) : Promise.resolve(null)) };
const gateStub = { withWalletLiquidityGate: (_svc: unknown, amount: number, settle: () => Promise<unknown>) => runWithLiquidityGate(world.pool, amount, settle) };
const core = loadModule(sourcePath('wallet-settlement-core'));
const settlement = loadModule(sourcePath('wallet-settlement'), {
  ...SB, './wallet-ledger.ts': ledger, './wallet-liquidity-gate.ts': gateStub, './wallet-settlement-core.ts': core,
}, noReexport);
const commission = loadModule(sourcePath('commission'));

let handler!: (req: Request) => Promise<Response>;
loadModule('supabase/functions/wallet-checkout/index.ts', {
  'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: typeof handler) => { handler = h; } },
  'https://esm.sh/@supabase/supabase-js@2': {
    createClient: (_u: string, key: string) => key === 'ANON'
      ? { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }
      : world.svc(),
  },
  '../_shared/safe-error.ts': loadModule(sourcePath('safe-error')),
  '../_shared/commission.ts': commission,
  '../_shared/commission-config.ts': { getCommissionConfig: async () => ({ percent_bps: 0, fixed_pence: 95 }) },
  '../_shared/wallet-ledger.ts': ledger,
  '../_shared/wallet-settlement.ts': settlement,
});

const call = (body: Record<string, unknown>) => handler(new Request('https://fn.test/x', {
  method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));
const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, any> });

const rails = {
  donation: { label: 'hub donation', req: (rid: string) => ({ type: 'hub_donation', campaign_id: CAMPAIGN, amount_pence: 2500, client_request_id: rid }),
    debit: 2500, transfer: 2500, dest: ACCT_HUB, fee: undefined as number | undefined, rows: (w: World) => w.donations.length },
  membership: { label: 'hub membership', req: (rid: string) => ({ type: 'hub_membership', membership_type_id: TIER, client_request_id: rid }),
    debit: 1095, transfer: 1000, dest: ACCT_HUB, fee: 95, rows: (w: World) => w.memberships.length },
  pass: { label: 'pass purchase', req: (rid: string) => ({ type: 'unit_purchase', unit_item_id: ITEM, client_request_id: rid }),
    debit: 2000, transfer: 1900, dest: ACCT_BIZ, fee: 100, rows: (w: World) => w.passes.length },
} as const;

const CRITICAL = () => new Pool('critical', 493, 10_000);   // the real 2 Oct situation: £4.93 available, £100 reserve
const HEALTHY = () => new Pool('healthy', 100_000, 10_000);

beforeEach(() => { world = new World(); world.pool = HEALTHY(); installStripe(world); });

/* ── each rail ────────────────────────────────────────────────────────────── */

for (const [key, r] of Object.entries(rails)) {
  describe(`${r.label}: Critical liquidity refuses BEFORE the Wallet is debited`, () => {
    test('503, the calm unavailable answer, and nothing at all has moved', async () => {
      world.pool = CRITICAL();
      const before = world.balance;
      const res = await json(await call(r.req(`req-${key}-crit-0001`)));

      assert.equal(res.status, 503);
      assert.equal(res.body.reason, 'liquidity_unavailable');
      assert.equal(res.body.no_charge, true);
      assert.equal(res.body.error, WALLET_UNAVAILABLE_NO_CHARGE);
      assert.match(res.body.error, /^Wallet temporarily unavailable\. No money has been taken\. Please use another payment method\.$/);

      assert.equal(world.debitCalls, 0, 'the debit primitive was reached');
      assert.equal(world.ledger.length, 0, 'a ledger row exists for a payment that was refused');
      assert.equal(world.balance, before, 'the Wallet balance moved');
      assert.equal(world.transfers.length, 0, 'a merchant transfer was created');
      assert.equal(r.rows(world), 0, 'a completed purchase/membership/donation exists');
      assert.equal(world.ledger.filter((x) => x.type === 'refund').length, 0, 'a compensating refund row exists although nothing was taken');
      assert.equal(world.failed.length, 0, 'a failed-fulfilment record was written for a payment that never started');
      assert.equal(world.reversals.length, 0);
      assert.equal(world.pool.held, 0);
    });

    test('it leaves no attempt behind: the SAME reference succeeds once the Wallet is healthy', async () => {
      world.pool = CRITICAL();
      const rid = `req-${key}-retry-0001`;
      assert.equal((await json(await call(r.req(rid)))).status, 503);
      assert.equal(world.claims.size, 0, 'the refused attempt was left in the registry');

      world.pool = HEALTHY();
      const ok = await json(await call(r.req(rid)));
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(world.debitCalls, 1);
      assert.equal(world.transfers.length, 1);
      assert.equal(r.rows(world), 1);
    });

    test('Low status with no real headroom above the reserve is refused too; headroom is measured above the floor', async () => {
      world.pool = new Pool('low', 10_000 + r.transfer - 1, 10_000);   // one penny short
      assert.equal((await json(await call(r.req(`req-${key}-low-000001`)))).status, 503);
      assert.equal(world.debitCalls, 0);
      world.pool = new Pool('low', 10_000 + r.transfer, 10_000);       // exactly enough
      assert.equal((await json(await call(r.req(`req-${key}-low-000002`)))).status, 200);
    });

    test('an unreadable Stripe balance FAILS CLOSED: refused, nothing debited, no reservation made', async () => {
      world.pool = new Pool('unknown', 0, 0);
      const res = await json(await call(r.req(`req-${key}-unk-000001`)));
      assert.equal(res.status, 503);
      assert.equal(res.body.no_charge, true);
      assert.equal(world.debitCalls, 0);
      assert.equal(world.pool.reserved.length, 0);
      assert.equal(world.claims.size, 0);
    });
  });

  describe(`${r.label}: healthy liquidity — the purchase is unchanged`, () => {
    test('exactly one debit and one transfer, to the right destination, for the right amounts', async () => {
      const before = world.balance;
      const res = await json(await call(r.req(`req-${key}-ok-0000001`)));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.ok, true);

      assert.equal(world.debitCalls, 1);
      assert.equal(world.ledger.filter((x) => x.type === 'spend').length, 1);
      assert.equal(world.ledger[0].amount_pence, -r.debit, 'the customer is debited the right total');
      assert.equal(world.balance, before - r.debit);
      assert.equal(res.body.balance_pence, before - r.debit);
      assert.equal(world.ledger[0].platform_fee_pence ?? undefined, r.fee, 'platform fee treatment changed');

      assert.equal(world.transfers.length, 1);
      assert.equal(world.transfers[0].destination, r.dest, 'wrong merchant destination');
      assert.equal(world.transfers[0].amount, r.transfer, 'wrong transfer amount');
      assert.equal(world.transfers[0].key, `wallet-txn:${world.ledger[0].id}`, 'the transfer is not keyed on the ledger row');
      assert.equal(world.ledger[0].transfer_state, 'sent');
      assert.equal(r.rows(world), 1, 'the purchase/membership/donation was not recorded exactly once');
    });

    test('what is reserved is the transfer that LEAVES Stripe — not the customer\'s total — held across the transfer and released after', async () => {
      await call(r.req(`req-${key}-res-000001`));
      assert.deepEqual(world.pool.reserved, [r.transfer]);
      assert.equal(world.transfers[0].heldAtCall, r.transfer, 'the reservation was not held while the transfer was made');
      assert.equal(world.pool.held, 0);
      assert.equal(world.pool.released.length, 1);
    });

    test('retry and double-tap safe: a completed reference replays, and a second simultaneous tap is refused', async () => {
      const rid = `req-${key}-idem-00001`;
      world.transferDelayMs = 20;
      const [a, b] = await Promise.all([call(r.req(rid)).then(json), call(r.req(rid)).then(json)]);
      assert.deepEqual([a.status, b.status].sort(), [200, 409], 'one tap pays, the other is told it is already going through');
      world.transferDelayMs = 0;
      const again = await json(await call(r.req(rid)));
      assert.equal(again.status, 200);
      assert.equal(world.debitCalls, 1, 'a retry debited again');
      assert.equal(world.transfers.length, 1, 'a retry transferred again');
      assert.equal(r.rows(world), 1);
    });

    test('a reference reused for a DIFFERENT payment is refused and moves nothing', async () => {
      const rid = `req-${key}-conf-00001`;
      await call(r.req(rid));
      const other = key === 'donation' ? { ...r.req(rid), amount_pence: 9900 } : key === 'membership' ? { ...r.req(rid), membership_type_id: 'tier-2' } : { ...r.req(rid), unit_item_id: 'item-2' };
      if (key === 'membership') world.tables.hub_membership_types = { ...world.tables.hub_membership_types!, id: 'tier-2', price_pence: 2000 };
      if (key === 'pass') world.tables.book_unit_items = { ...world.tables.book_unit_items!, id: 'item-2', price_pence: 4000 };
      const res = await json(await call(other));
      assert.equal(res.status, 409);
      assert.equal(world.debitCalls, 1);
      assert.equal(world.transfers.length, 1);
    });
  });

  describe(`${r.label}: the reservation is always released, and a failure cannot strand headroom`, () => {
    test('Stripe refusing the transfer reverses the debit AND releases the reservation', async () => {
      world.stripeMode = 'reject';
      const res = await json(await call(r.req(`req-${key}-rej-000001`)));
      assert.equal(res.status, 502);
      assert.equal(world.pool.held, 0, 'headroom was stranded');
      assert.equal(world.pool.released.length, 1);
      assert.equal(world.balance, 50_000, 'the customer was not made whole');
      assert.equal(world.ledger.filter((x) => x.type === 'refund').length, 1);
      assert.equal(r.rows(world), 0);
    });

    test('a debit that THROWS still releases the reservation', async () => {
      const svc = world.svc.bind(world);
      world.svc = () => { const c = svc(); const rpc = c.rpc; c.rpc = ((n: string, a: any) => { if (n === 'wallet_debit_with_ledger') throw new Error('db down'); return rpc(n, a); }) as any; return c; };
      const res = await call(r.req(`req-${key}-thr-000001`));
      assert.equal(res.status, 500);
      assert.equal(world.pool.held, 0);
      assert.equal(world.pool.released.length, 1);
    });

    test('one failed attempt cannot strand headroom that another needs: exactly enough headroom still serves the next buyer', async () => {
      world.pool = new Pool('healthy', 10_000 + r.transfer, 10_000);     // room for exactly ONE of these
      world.stripeMode = 'reject';
      assert.equal((await json(await call(r.req(`req-${key}-fail-00001`)))).status, 502);
      assert.equal(world.pool.held, 0);
      world.stripeMode = 'ok';
      const next = await json(await call(r.req(`req-${key}-next-00001`)));
      assert.equal(next.status, 200, 'headroom stayed held by the failed attempt');
    });
  });

  describe(`${r.label}: the payout and self-payment protections still run first`, () => {
    test('a self-payment is refused before the attempt is claimed, the gate is asked, or anything is debited', async () => {
      world.selfPay = async () => ({ status: 403, body: { error: 'You cannot pay yourself.' } });
      const res = await json(await call(r.req(`req-${key}-self-00001`)));
      assert.equal(res.status, 403);
      assert.equal(world.claimCalls, 0, 'an attempt was claimed for a refused self-payment');
      assert.equal(world.pool.snapshotCalls, 0, 'the liquidity gate ran before the self-payment check');
      assert.equal(world.debitCalls, 0);
    });

    test('the self-payment check is made on the same destination the transfer goes to', async () => {
      const seen: string[] = [];
      world.selfPay = async (_u, acct) => { seen.push(acct); return null; };
      await call(r.req(`req-${key}-dest-00001`));
      assert.deepEqual(seen, [r.dest]);
      assert.equal(world.transfers[0].destination, r.dest);
    });
  });

  describe(`${r.label}: resuming an attempt whose money already moved`, () => {
    test('is NOT described as "nothing was taken", is left exactly as it was, and debits nothing new', async () => {
      const rid = `req-${key}-resume-0001`;
      // First request: debit succeeds, Stripe loses the reply → attempt is unresolved.
      world.stripeMode = 'ok';
      const orig = (globalThis as any).fetch;
      (globalThis as any).fetch = async (url: string, init: any) => { if (/\/v1\/transfers$/.test(url)) throw new Error('socket hang up'); return orig(url, init); };
      const first = await json(await call(r.req(rid)));
      assert.equal(first.status, 502);
      assert.equal(world.claims.get(rid)!.status, 'unresolved');
      const debitsAfterFirst = world.debitCalls;
      installStripe(world);

      world.pool = CRITICAL();
      const retry = await json(await call(r.req(rid)));
      assert.equal(retry.status, 503);
      assert.equal(retry.body.error, WALLET_UNAVAILABLE_RESUMING);
      assert.equal(retry.body.no_charge, false, 'told the customer nothing was taken when they had been debited');
      assert.doesNotMatch(retry.body.error, /No money has been taken/);
      assert.equal(world.claims.get(rid)!.status, 'unresolved', 'the unresolved attempt was deleted — its money would be orphaned');
      assert.equal(world.debitCalls, debitsAfterFirst, 'a resume debited again');
      assert.equal(world.ledger.filter((x) => x.type === 'refund').length, 0);

      world.pool = HEALTHY();
      const done = await json(await call(r.req(rid)));
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.equal(world.ledger.filter((x) => x.type === 'spend').length, 1, 'exactly one debit for the whole story');
      assert.equal(r.rows(world), 1);
    });
  });
}

/* ── the exempt flow ──────────────────────────────────────────────────────── */

describe('shift boost: platform-retained, no merchant transfer — correctly outside the gate', () => {
  test('goes through even while Wallet is Critical, never reads Stripe, and creates no transfer', async () => {
    world.pool = CRITICAL();
    const res = await json(await call({ type: 'shift_boost', shift_id: 's-1', client_request_id: 'req-boost-000001' }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(world.pool.snapshotCalls, 0, 'a no-transfer spend consumed a liquidity read');
    assert.equal(world.pool.reserved.length, 0);
    assert.equal(world.transfers.length, 0);
    assert.equal(world.debitCalls, 1);
    assert.equal(world.balance, 50_000 - 299);
  });
});

/* ── across rails: one pool ───────────────────────────────────────────────── */

describe('simultaneous Wallet spends on DIFFERENT rails share ONE pool and cannot oversubscribe it', () => {
  /** Headroom for exactly one of the two transfers; both are in flight together. */
  const race = async (a: () => Promise<{ status: number }>, b: () => Promise<{ status: number }>, headroom: number) => {
    world.pool = new Pool('healthy', 10_000 + headroom, 10_000);
    world.transferDelayMs = 25;                       // keep both settlements overlapping
    const out = await Promise.all([a(), b()]);
    world.transferDelayMs = 0;
    return out.map((o) => o.status).sort();
  };
  const viaRoute = (k: keyof typeof rails, rid: string) => () => call(rails[k].req(rid)).then(json);
  /** What create-event-ticket-intent and create-gift-intent do: the same gate, around their own settlement. */
  const viaOtherRail = (amount: number) => async () => {
    const out = await runWithLiquidityGate(world.pool, amount, async () => {
      world.debitCalls++; await new Promise((r) => setTimeout(r, 25)); return 'paid';
    });
    return { status: out.ok ? 200 : 503 };
  };

  test('donation and membership at the same time: one settles, the other is refused undebited', async () => {
    const statuses = await race(viaRoute('donation', 'req-race-don-0001'), viaRoute('membership', 'req-race-mem-0001'), 2500);
    assert.deepEqual(statuses, [200, 503]);
    assert.equal(world.debitCalls, 1);
    assert.equal(world.transfers.length, 1);
    assert.ok(world.pool.peakHeld <= 2500, `the pool was oversubscribed (peak ${world.pool.peakHeld}p held against 2500p headroom)`);
    assert.equal(world.pool.held, 0);
  });

  test('pass purchase and event ticket at the same time (event tickets use the same gate)', async () => {
    const statuses = await race(viaRoute('pass', 'req-race-pass-001'), viaOtherRail(100), 1900);
    assert.deepEqual(statuses, [200, 503]);
    assert.equal(world.pool.held, 0);
    assert.ok(world.pool.peakHeld <= 1900);
  });

  test('gift and donation at the same time (gifts use the same gate)', async () => {
    const statuses = await race(viaOtherRail(1900), viaRoute('donation', 'req-race-gdon-001'), 2500);
    // 1900 + 2500 > 2500 headroom: exactly one fits
    assert.deepEqual(statuses, [200, 503]);
    assert.ok(world.pool.peakHeld <= 2500);
    assert.equal(world.pool.held, 0);
  });

  test('pass and membership and donation together over headroom for two: exactly two settle', async () => {
    world.pool = new Pool('healthy', 10_000 + 1900 + 1000, 10_000);    // pass(1900) + membership(1000) fit; donation(2500) does not fit beside them
    world.transferDelayMs = 25;
    const out = await Promise.all([
      call(rails.pass.req('req-race3-pass-01')).then(json),
      call(rails.membership.req('req-race3-mem-001')).then(json),
      call(rails.donation.req('req-race3-don-001')).then(json),
    ]);
    world.transferDelayMs = 0;
    const ok = out.filter((o) => o.status === 200).length;
    assert.ok(ok >= 1 && ok <= 2, `${ok} settled`);
    assert.ok(world.pool.peakHeld <= 2900, `oversubscribed: peak ${world.pool.peakHeld}p`);
    assert.equal(world.debitCalls, ok, 'a refused rail still debited');
    assert.equal(world.transfers.length, ok);
    assert.equal(world.pool.held, 0);
  });

  test('every Wallet merchant-settlement route reserves through the same single function and RPC — there is no per-rail pool', () => {
    const rpcs = read('supabase/functions/_shared/wallet-liquidity.ts');
    assert.match(code(rpcs), /svc\.rpc\('wallet_liquidity_reserve', \{\s*p_amount_pence: amountPence,\s*p_available_pence: availablePence,\s*p_reserve_pence: reservePence,\s*\}\)/,
      'the reservation takes only an amount and the pool state — no rail identifier');
    for (const f of ['create-event-ticket-intent', 'create-gift-intent']) {
      assert.match(code(read(`supabase/functions/${f}/index.ts`)), /withWalletLiquidityGate\(/, f);
    }
    assert.match(code(read('supabase/functions/_shared/wallet-settlement.ts')), /withWalletLiquidityGate\(svc, transferPence, run\)/);
    assert.match(code(read('supabase/functions/_shared/wallet-pay.ts')), /reserveWalletLiquidity\(svc,/);
  });
});

/* ── wiring contracts the fakes cannot prove ──────────────────────────────── */

describe('the real wiring: one implementation, final resolved amount, always released', () => {
  const wiring = code(read('supabase/functions/_shared/wallet-settlement.ts'));
  const wc = code(read('supabase/functions/wallet-checkout/index.ts'));

  test('the gate is asked for the transfer built from the SAME object the transfer is made from', () => {
    assert.match(wiring, /transfer: o\.debit\.transfer \? \{ amountPence: o\.debit\.transfer\.amountPence \} : undefined/);
    assert.match(wiring, /debit: \(\) => debitAndTransfer\(svc, o\.debit\)/);
  });

  test('the gate wiring is the shared one (real snapshot, atomic reservation, release in finally)', () => {
    assert.match(wiring, /withWalletLiquidityGate\(svc, transferPence, run\)/);
    const gate = code(read('supabase/functions/_shared/wallet-liquidity-gate.ts'));
    assert.match(gate, /getWalletLiquiditySnapshot\(svc\)/);
    assert.match(gate, /reserveWalletLiquidity\(svc, amount, available, reserve\)/);
    assert.match(code(read('supabase/functions/_shared/wallet-liquidity-gate-core.ts')), /finally \{\s*await deps\.release\(reservationId\);\s*\}/);
  });

  test('wallet-checkout never calls debitAndTransfer itself: all four routes spend through the gated helper', () => {
    assert.doesNotMatch(wc, /debitAndTransfer\(/);
    assert.doesNotMatch(wc, /import \{[^}]*debitAndTransfer/);
    assert.equal((wc.match(/await settleMerchantWalletPayment\(svc,/g) ?? []).length, 4);
    assert.equal((wc.match(/if \(settled\.kind === 'declined'\) return json\(settled\.body, settled\.status\);/g) ?? []).length, 4);
  });

  test('the self-payment block and attempt claim stay BEFORE the gated debit in every route', () => {
    for (const fn of ['hubDonation', 'hubMembership', 'unitPurchase']) {
      const body = wc.slice(wc.indexOf(`async function ${fn}`));
      const self = body.search(/selfPaymentBlock\(svc, userId,/);
      const claim = body.indexOf('await claimAttempt(');
      const spend = body.indexOf('await settleMerchantWalletPayment(');
      assert.ok(self !== -1 && claim !== -1 && spend !== -1, fn);
      assert.ok(self < claim && claim < spend, `${fn}: self-payment → claim → gated spend`);
    }
  });

  test('the pass route\'s self-payment check and its transfer use one and the same destination variable', () => {
    const body = wc.slice(wc.indexOf('async function unitPurchase'), wc.indexOf('async function shiftBoost'));
    const m = body.match(/selfPaymentBlock\(svc, userId, ([\w.]+)\)/);
    assert.ok(m, 'the pass route lost its self-payment check');
    assert.match(body, new RegExp(`destination: ${m![1].replace('.', '\\.')},`), 'the transfer goes somewhere other than the account that was self-payment-checked');
  });

  test('a decline releases only an attempt that never started: this user\'s own, in_flight, with no wallet transaction linked', () => {
    const rel = code(read('supabase/functions/_shared/wallet-ledger.ts'));
    const fn = rel.slice(rel.indexOf('export async function releaseUnstartedAttempt'));
    assert.match(fn, /\.eq\('client_request_id', requestId\)\s*\.eq\('user_id', userId\)\s*\.eq\('status', 'in_flight'\)\s*\.is\('wallet_transaction_id', null\)/);
  });

  test('the customer wording is the Wallet preflight wording, and says no money was taken only when that is true', () => {
    assert.equal(WALLET_UNAVAILABLE_NO_CHARGE, 'Wallet temporarily unavailable. No money has been taken. Please use another payment method.');
    assert.doesNotMatch(WALLET_UNAVAILABLE_RESUMING, /No money has been taken/);
  });

  test('mobile shows a decline as "Wallet temporarily unavailable", not as a failed payment — inside the sheet (see wallet-sheet-failure.node.test.ts)', () => {
    const api = code(read('lib/local-api.ts'));
    assert.match(api, /export \{ WalletUnavailableError, walletFailureNotice \} from '\.\/wallet-outcome'/);
    assert.match(api, /b\?\.reason === 'liquidity_unavailable'\) throw new WalletUnavailableError\(msg, b\.no_charge !== false\)/);
    const outcome = code(read('lib/wallet-outcome.ts'));
    assert.match(outcome, /title: 'Wallet temporarily unavailable',\s*message: 'No money has been taken\. Please use another payment method\.'/);
    for (const f of ['app/hub-donate.tsx', 'app/hubs/[id].tsx', 'app/local-buy-unit.tsx']) {
      assert.match(code(read(f)), /setPayNotice\(walletFailureNotice\(e, '/, f);
    }
  });

});
