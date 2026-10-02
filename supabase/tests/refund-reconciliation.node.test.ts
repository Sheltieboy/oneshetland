/**
 * refund-reconciliation.node.test.ts
 *
 * Two real live event-ticket refunds (25 Sep 2026) refunded the customer but
 * left the merchant's transfer un-reversed and OneShetland's fee un-refunded,
 * while event_ticket_orders said "refunded". This proves the hardening:
 *
 *   · whichever way a refund is initiated, the merchant's side is checked
 *   · a refund that left the merchant paid can never look reconciled
 *   · a recent FULL event-ticket refund is repaired automatically, atomically
 *     and idempotently; everything else is flagged for a person
 *   · repeats, duplicate webhooks and concurrent actors never double-reverse
 *     the transfer or double-refund the fee
 *   · errors and partial states are surfaced, never swallowed
 *
 * The orchestration runs against an in-memory MODEL of Stripe's transfer /
 * application-fee behaviour (caps, proportional fee refund on a reversal,
 * idempotency keys). No real Stripe call or money movement happens here; the
 * live checks at the end are read-only.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  assessRefund, repairPlan, autoRepairVerdict, reconcileRefundedCharge,
  type RefundFacts, type StripeOps, type ReconStore, type ReconRow, type ReconState, type AutoRepairPolicy,
} from '../functions/_shared/refund-reconcile-core.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

function sql(body: string): Record<string, unknown>[] {
  let out: string;
  try {
    out = execFileSync('npx',
      ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`supabase db query failed: ${err.stdout || err.stderr || err.message}`);
  }
  const parsed = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (parsed._tag === 'Error' || parsed.error) throw new Error(`query error: ${JSON.stringify(parsed.error).slice(0, 300)}`);
  return parsed.rows ?? [];
}

/* ── A model of Stripe's destination-charge money legs ────────────────────── */

const NOW = 1_790_933_862;
const HOUR = 3600;

class FakeStripe implements StripeOps {
  writes: { op: string; id: string; amount: number; key: string }[] = [];
  private seen = new Map<string, { id: string }>();
  failReverseWith: string | null = null;
  throwAfterApplyingReverse = false;
  readFails = false;
  merchantNet = 0;       // net movement of the MERCHANT's balance caused by repairs
  platformNet = 0;       // net movement of OneShetland's balance caused by repairs
  f: RefundFacts;
  constructor(f: RefundFacts) { this.f = f; }

  async getFacts(): Promise<RefundFacts> {
    if (this.readFails) throw new Error('Stripe unreachable');
    return JSON.parse(JSON.stringify(this.f));
  }
  async reverseTransfer(id: string, amount: number, key: string) {
    const hit = this.seen.get(key); if (hit) return hit;
    if (this.failReverseWith) throw new Error(this.failReverseWith);
    const t = this.f.transfer!;
    if (amount > t.amount - t.amount_reversed) throw new Error('Reversal would exceed the transfer');
    this.writes.push({ op: 'reverse_transfer', id, amount, key });
    t.amount_reversed += amount;
    // refund_application_fee: proportional to the amount reversed, never beyond what is left.
    let feeBack = 0;
    if (this.f.fee) {
      const remaining = this.f.fee.amount - this.f.fee.amount_refunded;
      feeBack = t.amount_reversed >= t.amount ? remaining : Math.min(remaining, Math.round(this.f.fee.amount * amount / t.amount));
      this.f.fee.amount_refunded += feeBack;
    }
    this.merchantNet += -amount + feeBack;   // merchant is debited the reversal and credited the fee refund
    this.platformNet += amount - feeBack;
    const r = { id: `trr_${this.writes.length}` }; this.seen.set(key, r);
    if (this.throwAfterApplyingReverse) throw new Error('network error after Stripe applied it');
    return r;
  }
  async refundFee(id: string, amount: number, key: string) {
    const hit = this.seen.get(key); if (hit) return hit;
    const fee = this.f.fee!;
    if (amount > fee.amount - fee.amount_refunded) throw new Error('Fee refund would exceed the fee');
    this.writes.push({ op: 'refund_fee', id, amount, key });
    fee.amount_refunded += amount;
    this.merchantNet += amount; this.platformNet -= amount;
    const r = { id: `feer_${this.writes.length}` }; this.seen.set(key, r);
    return r;
  }
}

class FakeStore implements ReconStore {
  rows = new Map<string, ReconRow & Record<string, unknown>>();
  events: { kind: string; actor: string; detail: Record<string, unknown> }[] = [];
  claimed = new Set<string>();
  rail = 'event_ticket';
  async railFor() { return { rail: this.rail, order_id: this.rail === 'event_ticket' ? 'order-1' : null }; }
  async load(id: string) { return (this.rows.get(id) as ReconRow | undefined) ?? null; }
  async save(r: Parameters<ReconStore['save']>[0]) {
    const prev = this.rows.get(r.charge_id);
    this.rows.set(r.charge_id, {
      charge_id: r.charge_id, state: r.state, rail: r.rail,
      repair_attempts: (prev?.repair_attempts ?? 0) + (r.attempted_repair ? 1 : 0),
      first_flagged_at: prev?.first_flagged_at ?? (r.state !== 'reconciled' ? 'T' : null),
      transfer_gap: r.transfer_gap, fee_gap: r.fee_gap, last_error: r.last_error,
    });
  }
  async claimRepair(id: string) { if (this.claimed.has(id)) return false; this.claimed.add(id); return true; }
  async releaseRepair(id: string) { this.claimed.delete(id); }
  async event(_c: string, kind: string, actor: string, detail: Record<string, unknown>) { this.events.push({ kind, actor, detail }); }
}

const policy = (over: Partial<AutoRepairPolicy> = {}): AutoRepairPolicy =>
  ({ enabled: true, max_refund_age_hours: 72, nowUnix: NOW, ...over });

/** £1.96 event ticket: transfer 196 to the merchant, platform fee 96 collected from it. */
const ticket = (over: Partial<RefundFacts> = {}, t: Partial<NonNullable<RefundFacts['transfer']>> = {}, fee: Partial<NonNullable<RefundFacts['fee']>> = {}): RefundFacts => ({
  charge_id: 'ch_test', payment_intent_id: 'pi_test', charge_amount: 196, amount_refunded: 196,
  transfer: { id: 'tr_test', amount: 196, amount_reversed: 0, ...t },
  fee: { id: 'fee_test', amount: 96, amount_refunded: 0, ...fee },
  last_refund_created_unix: NOW - 10 * 60,
  ...over,
});

const run = (stripe: FakeStripe, store: FakeStore, o: { allowRepair?: boolean; force?: boolean; policy?: AutoRepairPolicy; actor?: string } = {}) =>
  reconcileRefundedCharge(stripe, store, 'ch_test', {
    actor: o.actor ?? 'webhook', allowRepair: o.allowRepair ?? true, force: o.force, policy: o.policy ?? policy(),
  });

/* ── 1. The assessment: the order row is not the evidence ─────────────────── */

describe('assessment: a refund is reconciled only when the merchant\'s legs came back', () => {
  test('app-initiated refund (reverse_transfer + refund_application_fee): reconciled', () => {
    const a = assessRefund(ticket({}, { amount_reversed: 196 }, { amount_refunded: 96 }));
    assert.equal(a.state, 'reconciled');
  });

  test('THE LIVE CASE: customer refunded in full, transfer un-reversed, fee un-refunded → needs_repair with exact gaps', () => {
    const a = assessRefund(ticket());
    assert.equal(a.state, 'needs_repair');
    assert.ok(a.state === 'needs_repair' && a.transfer_gap === 196 && a.fee_gap === 96 && a.full);
  });

  test('transfer reversed but fee not refunded is NOT reconciled', () => {
    const a = assessRefund(ticket({}, { amount_reversed: 196 }, { amount_refunded: 0 }));
    assert.ok(a.state === 'needs_repair' && a.transfer_gap === 0 && a.fee_gap === 96);
  });

  test('fee refunded but transfer not reversed is NOT reconciled', () => {
    const a = assessRefund(ticket({}, { amount_reversed: 0 }, { amount_refunded: 96 }));
    assert.ok(a.state === 'needs_repair' && a.transfer_gap === 196 && a.fee_gap === 0);
  });

  test('a charge with no connected-account transfer, or nothing refunded, is out of scope', () => {
    assert.equal(assessRefund({ ...ticket(), transfer: null }).state, 'not_applicable');
    assert.equal(assessRefund(ticket({ amount_refunded: 0 })).state, 'not_refunded');
  });

  test('partial refund apportioned by Stripe is reconciled, including a 1p rounding difference', () => {
    const half = ticket({ amount_refunded: 98 }, { amount_reversed: 98 }, { amount_refunded: 48 });
    assert.equal(assessRefund(half).state, 'reconciled');
    const rounded = ticket({ amount_refunded: 65 }, { amount_reversed: 65 }, { amount_refunded: 32 }); // 96*65/196 = 31.8 → 32 expected 32
    assert.equal(assessRefund(rounded).state, 'reconciled');
    const offByOne = ticket({ amount_refunded: 65 }, { amount_reversed: 65 }, { amount_refunded: 31 });
    assert.equal(assessRefund(offByOne).state, 'reconciled');
  });

  test('partial refund with the merchant untouched needs review (never "full")', () => {
    const a = assessRefund(ticket({ amount_refunded: 98 }));
    assert.ok(a.state === 'needs_review' && !a.full && a.transfer_gap === 98);
  });
});

describe('repair plan: recomputed from live state, never double-applied', () => {
  test('full refund, nothing reversed → ONE atomic reversal of the whole transfer (it carries the fee refund)', () => {
    const f = ticket(); const plan = repairPlan(f, assessRefund(f));
    assert.deepEqual(plan.map((s) => [s.kind, s.amount]), [['reverse_transfer', 196]]);
  });

  test('transfer already reversed, fee outstanding → only the fee refund', () => {
    const f = ticket({}, { amount_reversed: 196 }, { amount_refunded: 0 }); const plan = repairPlan(f, assessRefund(f));
    assert.deepEqual(plan.map((s) => [s.kind, s.amount]), [['refund_fee', 96]]);
  });

  test('transfer partly reversed → only the remainder is reversed', () => {
    const f = ticket({}, { amount_reversed: 100 }, { amount_refunded: 49 }); const plan = repairPlan(f, assessRefund(f));
    assert.deepEqual(plan.map((s) => [s.kind, s.amount]), [['reverse_transfer', 96]]);
  });

  test('already fully reconciled → no steps (nothing is reversed or refunded twice)', () => {
    const f = ticket({}, { amount_reversed: 196 }, { amount_refunded: 96 });
    assert.deepEqual(repairPlan(f, assessRefund(f)), []);
  });

  test('the fee is NEVER refunded on its own while the merchant still holds the transfer', () => {
    const f = ticket();
    for (const s of repairPlan(f, assessRefund(f))) assert.notEqual(s.kind, 'refund_fee');
  });

  test('a partial refund has no automatic plan', () => {
    const f = ticket({ amount_refunded: 98 }); assert.deepEqual(repairPlan(f, assessRefund(f)), []);
  });

  test('idempotency keys are stable for the same live state and differ once state changes', () => {
    const a = ticket(); const b = ticket(); const c = ticket({}, { amount_reversed: 100 });
    assert.equal(repairPlan(a, assessRefund(a))[0].idempotency_key, repairPlan(b, assessRefund(b))[0].idempotency_key);
    assert.notEqual(repairPlan(a, assessRefund(a))[0].idempotency_key, repairPlan(c, assessRefund(c))[0].idempotency_key);
  });
});

describe('when money may be moved automatically', () => {
  const a = () => assessRefund(ticket());
  test('recent full event-ticket refund, enabled → allowed', () => {
    assert.equal(autoRepairVerdict('event_ticket', a(), ticket(), policy()).allowed, true);
  });
  test('switched off → not allowed', () => {
    assert.equal(autoRepairVerdict('event_ticket', a(), ticket(), policy({ enabled: false })).allowed, false);
  });
  test('any other rail → not allowed', () => {
    for (const rail of ['other', 'product_order', 'gift', 'pass']) {
      assert.equal(autoRepairVerdict(rail, a(), ticket(), policy()).allowed, false, rail);
    }
  });
  test('a refund older than the window → not allowed (a historical refund or a re-sent webhook cannot trigger a clawback)', () => {
    const old = ticket({ last_refund_created_unix: NOW - 73 * HOUR });
    assert.equal(autoRepairVerdict('event_ticket', assessRefund(old), old, policy()).allowed, false);
    const edge = ticket({ last_refund_created_unix: NOW - 72 * HOUR });
    assert.equal(autoRepairVerdict('event_ticket', assessRefund(edge), edge, policy()).allowed, true);
  });
  test('unknown refund time → not allowed', () => {
    const f = ticket({ last_refund_created_unix: null });
    assert.equal(autoRepairVerdict('event_ticket', assessRefund(f), f, policy()).allowed, false);
  });
  test('partial → not allowed', () => {
    const f = ticket({ amount_refunded: 98 });
    assert.equal(autoRepairVerdict('event_ticket', assessRefund(f), f, policy()).allowed, false);
  });
});

/* ── 2. Orchestration against the Stripe model ────────────────────────────── */

describe('app-initiated event refund: already reversed, verified, nothing moved', () => {
  test('transfer reversed and fee refunded → reconciled, zero Stripe writes', async () => {
    const s = new FakeStripe(ticket({}, { amount_reversed: 196 }, { amount_refunded: 96 })); const db = new FakeStore();
    const r = await run(s, db, { actor: 'refund-payment:admin' });
    assert.equal(r.state, 'reconciled');
    assert.equal(s.writes.length, 0);
    assert.equal(db.rows.get('ch_test')?.state, 'reconciled');
  });
});

describe('externally initiated refund (Dashboard) can never silently look reconciled', () => {
  test('recent full event refund → repaired automatically in ONE reversal; merchant and platform both end level', async () => {
    const s = new FakeStripe(ticket()); const db = new FakeStore();
    const r = await run(s, db);
    assert.equal(r.state, 'repaired');
    assert.deepEqual(s.writes.map((w) => [w.op, w.amount]), [['reverse_transfer', 196]]);
    assert.equal(s.f.transfer!.amount_reversed, 196);
    assert.equal(s.f.fee!.amount_refunded, 96);
    // £1.00 each way: the merchant hands back the net it kept, OneShetland recovers what it absorbed.
    assert.equal(s.merchantNet, -100);
    assert.equal(s.platformNet, 100);
    assert.deepEqual(db.events.map((e) => e.kind), ['repaired']);
  });

  test('automatic repair switched off → flagged needs_repair, NOT reconciled, nothing moved', async () => {
    const s = new FakeStripe(ticket()); const db = new FakeStore();
    const r = await run(s, db, { policy: policy({ enabled: false }) });
    assert.equal(r.state, 'needs_repair');
    assert.equal(s.writes.length, 0);
    assert.notEqual(db.rows.get('ch_test')?.state, 'reconciled');
    assert.equal(db.rows.get('ch_test')?.transfer_gap, 196);
  });

  test('THE HISTORICAL CASE: an old refund is flagged with exact gaps and nothing is moved', async () => {
    const s = new FakeStripe(ticket({ last_refund_created_unix: NOW - 7 * 24 * HOUR })); const db = new FakeStore();
    const r = await run(s, db);
    assert.equal(r.state, 'needs_repair');
    assert.equal(s.writes.length, 0);
    assert.deepEqual([r.transfer_gap, r.fee_gap], [196, 96]);
    assert.deepEqual(db.events.map((e) => e.kind), ['detected']);
  });

  test('the sweep (allowRepair false) never moves money, even for a recent eligible refund', async () => {
    const s = new FakeStripe(ticket()); const db = new FakeStore();
    const r = await run(s, db, { allowRepair: false, actor: 'sweep' });
    assert.equal(r.state, 'needs_repair');
    assert.equal(s.writes.length, 0);
  });

  test('another rail is flagged, never auto-repaired', async () => {
    const s = new FakeStripe(ticket()); const db = new FakeStore(); db.rail = 'other';
    assert.equal((await run(s, db)).state, 'needs_repair');
    assert.equal(s.writes.length, 0);
  });

  test('admin-approved repair (force) repairs an OLD refund, once', async () => {
    const s = new FakeStripe(ticket({ last_refund_created_unix: NOW - 7 * 24 * HOUR })); const db = new FakeStore();
    const r = await run(s, db, { force: true, actor: 'admin:someone' });
    assert.equal(r.state, 'repaired');
    assert.deepEqual(s.writes.map((w) => [w.op, w.amount]), [['reverse_transfer', 196]]);
    assert.equal(db.events.at(-1)?.actor, 'admin:someone');
  });

  test('force still refuses a partial refund', async () => {
    const s = new FakeStripe(ticket({ amount_refunded: 98 })); const db = new FakeStore();
    const r = await run(s, db, { force: true });
    assert.equal(r.state, 'needs_review');
    assert.equal(s.writes.length, 0);
  });
});

describe('idempotency: duplicates, retries and prior partial work', () => {
  test('a duplicate webhook / retry after a successful repair makes NO second write and stays "repaired"', async () => {
    const s = new FakeStripe(ticket()); const db = new FakeStore();
    assert.equal((await run(s, db)).state, 'repaired');
    assert.equal((await run(s, db)).state, 'repaired');
    assert.equal((await run(s, db)).state, 'repaired');
    assert.equal(s.writes.length, 1);
    assert.equal(s.f.transfer!.amount_reversed, 196);   // reversed once, not 392
    assert.equal(s.f.fee!.amount_refunded, 96);          // refunded once, not 192
    assert.equal(s.merchantNet, -100);
  });

  test('an already-reversed transfer is not reversed twice: only the missing fee is refunded', async () => {
    const s = new FakeStripe(ticket({}, { amount_reversed: 196 }, { amount_refunded: 0 })); const db = new FakeStore();
    assert.equal((await run(s, db)).state, 'repaired');
    assert.deepEqual(s.writes.map((w) => w.op), ['refund_fee']);
    assert.equal(s.f.transfer!.amount_reversed, 196);
  });

  test('an already-refunded fee is not refunded twice when the transfer still needs reversing', async () => {
    const s = new FakeStripe(ticket({}, { amount_reversed: 0 }, { amount_refunded: 96 })); const db = new FakeStore();
    assert.equal((await run(s, db)).state, 'repaired');
    assert.deepEqual(s.writes.map((w) => w.op), ['reverse_transfer']);
    assert.equal(s.f.fee!.amount_refunded, 96, 'fee must not exceed what was collected');
  });

  test('a partly reversed transfer reverses only the remainder', async () => {
    const s = new FakeStripe(ticket({}, { amount_reversed: 100 }, { amount_refunded: 49 })); const db = new FakeStore();
    assert.equal((await run(s, db)).state, 'repaired');
    assert.deepEqual(s.writes.map((w) => [w.op, w.amount]), [['reverse_transfer', 96]]);
    assert.equal(s.f.transfer!.amount_reversed, 196);
  });

  test('a concurrent repair already holds the claim → this caller moves nothing', async () => {
    const s = new FakeStripe(ticket()); const db = new FakeStore(); db.claimed.add('ch_test');
    const r = await run(s, db);
    assert.equal(s.writes.length, 0);
    assert.equal(r.state, 'needs_repair');
    assert.ok(r.steps_run.some((x) => x.includes('another-repair-in-progress')));
  });

  test('the claim is always released, even when Stripe refuses', async () => {
    const s = new FakeStripe(ticket()); s.failReverseWith = 'insufficient funds'; const db = new FakeStore();
    await run(s, db);
    assert.equal(db.claimed.has('ch_test'), false);
  });

  test('a network error AFTER Stripe applied the reversal re-reads and reports reconciled, not failed', async () => {
    const s = new FakeStripe(ticket()); s.throwAfterApplyingReverse = true; const db = new FakeStore();
    const r = await run(s, db);
    assert.equal(r.state, 'repaired');
    assert.equal(db.rows.get('ch_test')?.last_error, null);
    assert.equal(s.writes.length, 1);
  });

  test('a sweep re-confirming the same flag does not flood the audit trail', async () => {
    const s = new FakeStripe(ticket({ last_refund_created_unix: NOW - 7 * 24 * HOUR })); const db = new FakeStore();
    for (let i = 0; i < 5; i++) await run(s, db, { allowRepair: false, actor: 'sweep' });
    assert.equal(db.events.length, 1);
    assert.equal(db.rows.get('ch_test')?.repair_attempts, 0);
  });
});

describe('errors and partial states are surfaced, never swallowed', () => {
  test('Stripe refuses the reversal (merchant balance too low) → repair_failed with the reason; nothing else is touched', async () => {
    const s = new FakeStripe(ticket()); s.failReverseWith = 'Insufficient funds in the connected account'; const db = new FakeStore();
    const r = await run(s, db);
    assert.equal(r.state, 'repair_failed');
    const row = db.rows.get('ch_test')!;
    assert.equal(row.state, 'repair_failed');
    assert.match(String(row.last_error), /Insufficient funds/);
    assert.equal(row.repair_attempts, 1);
    assert.equal(s.writes.length, 0);
    assert.equal(s.f.fee!.amount_refunded, 0, 'the fee must not be refunded while the merchant still holds the money');
    assert.deepEqual(db.events.map((e) => e.kind), ['repair_failed']);
  });

  test('a later retry, once the cause is fixed, completes the repair', async () => {
    const s = new FakeStripe(ticket()); s.failReverseWith = 'Insufficient funds'; const db = new FakeStore();
    assert.equal((await run(s, db)).state, 'repair_failed');
    s.failReverseWith = null;
    assert.equal((await run(s, db, { force: true })).state, 'repaired');
    assert.equal(s.f.transfer!.amount_reversed, 196);
  });

  test('Stripe cannot be read → reported as an error and NOTHING is written or moved', async () => {
    const s = new FakeStripe(ticket()); s.readFails = true; const db = new FakeStore();
    const r = await run(s, db);
    assert.equal(r.state, 'error');
    assert.equal(db.rows.size, 0);
    assert.equal(s.writes.length, 0);
  });

  test('a partial refund with a gap is surfaced as needs_review with the exact gap', async () => {
    const s = new FakeStripe(ticket({ amount_refunded: 98 })); const db = new FakeStore();
    const r = await run(s, db);
    assert.equal(r.state, 'needs_review');
    assert.equal(r.transfer_gap, 98);
    assert.equal(s.writes.length, 0);
    assert.deepEqual(db.events.map((e) => e.kind), ['review']);
  });

  test('a charge with no transfer is out of scope and leaves no row', async () => {
    const s = new FakeStripe({ ...ticket(), transfer: null, fee: null }); const db = new FakeStore();
    const r = await run(s, db);
    assert.equal(r.state, 'not_applicable');
    assert.equal(db.rows.size, 0);
  });
});

/* ── 3. Source guards: the wiring is what these tests say it is ───────────── */

describe('wiring', () => {
  const webhook = code(read('supabase/functions/stripe-webhook/index.ts'));
  const refundFn = code(read('supabase/functions/refund-payment/index.ts'));
  const wiring = code(read('supabase/functions/_shared/refund-reconcile.ts'));
  const sweep = code(read('supabase/functions/refund-reconcile-sweep/index.ts'));
  const admin = code(read('supabase/functions/refund-reconcile/index.ts'));

  test('charge.refunded checks the merchant side AFTER the customer-side handlers, and a failure there cannot fail the event', () => {
    const start = webhook.indexOf("case 'charge.refunded'");
    const end = webhook.indexOf('default:', start);
    const block = webhook.slice(start, end);
    const refundAt = block.indexOf("'refund_event_tickets_for_payment'");
    const reconAt = block.indexOf('reconcileCharge(supabase');
    assert.ok(refundAt > 0 && reconAt > refundAt);
    assert.match(block.slice(reconAt - 400, reconAt + 900), /try \{[\s\S]*reconcileCharge[\s\S]*\} catch/);
    assert.match(block, /actor: 'webhook', allowRepair: true/);
  });

  test('refund-payment still asks Stripe for reverse_transfer and refund_application_fee AND now verifies the result', () => {
    assert.match(refundFn, /form\.set\('reverse_transfer', 'true'\)/);
    assert.match(refundFn, /form\.set\('refund_application_fee', 'true'\)/);
    assert.match(refundFn, /reconcileCharge\(svc, chargeId/);
    assert.match(refundFn, /reconciliation,/);
  });

  test('the only Stripe writes in the reconciler are a transfer reversal (with the fee refund) and an application-fee refund', () => {
    const posts = wiring.match(/stripePost\(`[^`]+`/g) ?? [];
    assert.equal(posts.length, 2);
    assert.ok(posts.some((p) => /\/transfers\/\$\{transferId\}\/reversals/.test(p)));
    assert.ok(posts.some((p) => /\/application_fees\/\$\{feeId\}\/refunds/.test(p)));
    assert.match(wiring, /refund_application_fee: 'true'/);
    assert.match(wiring, /'Idempotency-Key': idempotencyKey/);
    assert.doesNotMatch(wiring, /method: 'DELETE'|method: 'PUT'/);
  });

  test('the sweep is cron-secret authenticated and can never repair', () => {
    assert.match(sweep, /requireCronSecret\(req, corsHeaders\)/);
    assert.match(sweep, /allowRepair: false/);
    assert.doesNotMatch(sweep, /allowRepair: true|force/);
  });

  test('the admin function: admin gate first, repair needs confirm:true and a previously flagged charge, force only there', () => {
    const adminAt = admin.indexOf("if (!isAdmin) return json({ error: 'Admin only' }, 403);");
    const actionAt = admin.indexOf("body.action");
    assert.ok(adminAt > 0 && actionAt > adminAt);
    assert.match(admin, /body\.confirm !== true/);
    assert.match(admin, /has not been flagged yet/);
    assert.match(admin, /row\.state !== 'needs_repair' && row\.state !== 'repair_failed'/);
    assert.equal((admin.match(/force: true/g) ?? []).length, 1);
    assert.match(admin, /actor: `admin:\$\{user\.id\}`/);
    // scan is flag-only
    assert.match(admin, /action === 'scan'[\s\S]*?allowRepair: false/);
  });

  test('config: sweep is cron-only (no JWT), the admin function requires a JWT', () => {
    const toml = read('supabase/config.toml');
    assert.match(toml, /\[functions\.refund-reconcile-sweep\]\s*\nverify_jwt = false/);
    assert.match(toml, /\[functions\.refund-reconcile\]\s*\nverify_jwt = true/);
  });

  test('the migration is service-role only, schedules the flag-only sweep, and the view is not exposed', () => {
    const mig = read('supabase/migrations/20261028000000_refund_reconciliation.sql');
    for (const t of ['refund_reconciliation', 'refund_reconciliation_events']) {
      assert.match(mig, new RegExp(`revoke all on public\\.${t} from public, anon, authenticated`));
      assert.match(mig, new RegExp(`alter table public\\.${t} enable row level security`));
    }
    assert.match(mig, /revoke all on public\.event_refund_reconciliation from public, anon, authenticated/);
    assert.match(mig, /'refund-reconcile-sweep'/);
    assert.match(mig, /'unverified'/);
  });
});

describe('admin visibility: an order marked refunded is never presented as reconciled', () => {
  const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
  const panel = code(readFileSync(join(WEB, 'components/admin/RefundReconciliationPanel.tsx'), 'utf8'));
  const page = readFileSync(join(WEB, 'app/admin/payments/page.tsx'), 'utf8');

  test('the panel is mounted on the admin Payments page and reads only through the admin Edge Function', () => {
    assert.match(page, /<RefundReconciliationPanel \/>/);
    assert.match(panel, /functions\.invoke\("refund-reconcile"/);
    assert.doesNotMatch(panel, /\.from\(["']refund_reconciliation/);
    assert.doesNotMatch(panel, /console\.|localStorage|sessionStorage/);
  });

  test('it distinguishes the three legs: customer refunded, merchant transfer, platform fee', () => {
    assert.match(panel, /Customer/);
    assert.match(panel, /transfer not reversed/);
    assert.match(panel, /not refunded/);
    assert.match(panel, /An order marked “refunded” does not prove the merchant's money came back\./);
  });

  test('every state has a label and the open ones are separated from the settled ones', () => {
    for (const st of ['reconciled', 'repaired', 'needs_repair', 'needs_review', 'repair_failed']) assert.ok(panel.includes(`${st}:`), st);
    assert.match(panel, /r\.state !== "reconciled" && r\.state !== "repaired"/);
  });

  test('refunded-but-unchecked orders are surfaced as a warning, never as "all reconciled"', () => {
    assert.match(panel, /unverified\.length > 0/);
    assert.match(panel, /not been checked against/);
    const warn = panel.indexOf('unverified.length > 0 ?');
    const allGood = panel.indexOf('Every refund checked so far is reconciled.');
    assert.ok(warn > 0 && allGood > warn);
  });

  test('checking is read-only; repair needs an explicit confirmation that says exactly what moves, then sends confirm:true', () => {
    assert.match(panel, /action: "scan"/);
    const repairFn = panel.slice(panel.indexOf('async function repair('), panel.indexOf('const open ='));
    assert.ok(repairFn.indexOf('await confirm(') > 0 && repairFn.indexOf('await confirm(') < repairFn.indexOf('action: "repair"'));
    assert.match(repairFn, /This moves real money/);
    assert.match(repairFn, /Stripe may refuse if the merchant's balance is too low/);
    assert.match(repairFn, /confirm: true/);
    assert.match(repairFn, /danger: true/);
  });

  test('a partial refund offers no repair button — a person decides', () => {
    assert.match(panel, /r\.state === "needs_review" \? \(/);
  });
});

/* ── 4. Live, read-only ───────────────────────────────────────────────────── */

describe('live (read-only): schema, config and the historical refunds are visible', () => {
  test('the reconciliation tables are RLS-on, policy-free and unreachable by clients', () => {
    for (const t of ['refund_reconciliation', 'refund_reconciliation_events']) {
      const [rls] = sql(`select relrowsecurity as on from pg_class where oid = 'public.${t}'::regclass;`);
      assert.equal(rls.on, true);
      const [g] = sql(`select has_table_privilege('anon','public.${t}','select') a, has_table_privilege('authenticated','public.${t}','select') u;`);
      assert.deepEqual([g.a, g.u], [false, false]);
    }
    const [p] = sql(`select count(*)::int n from pg_policies where tablename in ('refund_reconciliation','refund_reconciliation_events');`);
    assert.equal(p.n, 0);
    const [v] = sql(`select has_table_privilege('anon','public.event_refund_reconciliation','select') a, has_table_privilege('authenticated','public.event_refund_reconciliation','select') u;`);
    assert.deepEqual([v.a, v.u], [false, false]);
  });

  test('the config switches are present with their intended values', () => {
    const rows = sql(`select key, value from public.admin_config where key like 'refunds.reconcile.%' order by key;`);
    assert.deepEqual(rows.map((r) => [r.key, r.value]), [
      ['refunds.reconcile.auto_repair_enabled', 'true'],
      ['refunds.reconcile.auto_repair_max_age_hours', '72'],
    ]);
  });

  test('the flag-only sweep is scheduled every 30 minutes', () => {
    const [j] = sql(`select schedule from cron.job where jobname = 'refund-reconcile-sweep';`);
    assert.equal(j.schedule, '*/30 * * * *');
  });

  test('the product_orders financial lock is installed and enabled in production, with the allowlist from the migration', () => {
    const [t] = sql(`select t.tgenabled::text as enabled, pg_get_functiondef(t.tgfoid) as def
                       from pg_trigger t
                      where t.tgrelid = 'public.product_orders'::regclass and t.tgname = 'tg_zz_lock_order_financial_columns';`);
    assert.ok(t, 'trigger missing from production');
    assert.equal(t.enabled, 'O');
    const def = String(t.def);
    assert.match(def, /tg_is_server_write\(\)/);
    assert.match(def, /to_jsonb\(new\) - lifecycle/);
    for (const col of ['status', 'tracking_ref', 'accepted_at', 'ready_at', 'posted_at', 'completed_at', 'cancelled_at', 'updated_at']) {
      assert.ok(def.includes(`'${col}'`), `${col} missing from the live allowlist`);
    }
    for (const money of ['total_pence', 'commission_pence', 'payment_intent_id', 'buyer_id', 'business_id']) {
      assert.ok(!def.includes(`'${money}'`), `${money} must not be in the live allowlist`);
    }
  });

  test('the book_unit_purchases financial lock is installed and enabled in production, with an EMPTY client allowlist', () => {
    const [t] = sql(`select t.tgenabled::text as enabled, pg_get_functiondef(t.tgfoid) as def
                       from pg_trigger t
                      where t.tgrelid = 'public.book_unit_purchases'::regclass and t.tgname = 'tg_zz_lock_pass_financial_columns';`);
    assert.ok(t, 'trigger missing from production');
    assert.equal(t.enabled, 'O');
    const def = String(t.def);
    assert.match(def, /lifecycle text\[\] := ARRAY\[\]::text\[\]|lifecycle text\[\] := array\[\]::text\[\]/i);
    assert.match(def, /tg_is_server_write\(\)/);
    assert.match(def, /to_jsonb\(new\) - lifecycle/);
    assert.match(def, /server-managed/);
    // The pre-existing refund / use-balance lock is still in place beside it.
    const [r] = sql(`select count(*)::int as n from pg_trigger where tgrelid = 'public.book_unit_purchases'::regclass and tgname = 'tg_zz_lock_pass_refund_columns' and tgenabled = 'O';`);
    assert.equal(r.n, 1);
  });

  test('both historical refunded event orders are visible to operations and NOT presented as reconciled', () => {
    const rows = sql(`select order_id::text, reconciliation_state from public.event_refund_reconciliation order by refunded_at;`);
    assert.ok(rows.length >= 2);
    for (const r of rows) assert.notEqual(r.reconciliation_state, 'reconciled', 'the two live orphans must not look reconciled');
  });
});
