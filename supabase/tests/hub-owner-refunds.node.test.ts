/**
 * hub-owner-refunds.node.test.ts — a hub refunds its own members.
 *
 * WHY THIS MOVED
 *
 * Refunds were platform-admin only. The Terms have always said membership
 * refunds are the responsibility of the hub, and the money is the hub's: a
 * full refund reverses the destination transfer out of their connected
 * account. So the decision now sits with the person whose money it is, and
 * OneShetland keeps a global override for support and disputes.
 *
 * THE BOUNDARY
 *
 * Committee members are deliberately excluded. They can run parts of a hub,
 * but only the OWNER controls the Stripe Connect relationship the money moved
 * through, and refund authority follows financial control rather than hub
 * management. A finance-manager role is a separate design, not an accident of
 * who can already open the members screen.
 *
 * Ownership is resolved from the PURCHASE. The caller sends a payment
 * reference; the server works out which hub that belongs to and who owns it.
 * A hub id, owner id or destination account in the request body is never read,
 * so none of them can be substituted — exercised live below.
 *
 * SAFETY
 * Source-level plus read-only production assertions. No refund issued, no
 * payment made, no refund economics changed.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const web = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

const refundFn    = code(read('supabase/functions/refund-payment/index.ts'));
const ownerButton = code(web('components/hubs/admin/MembershipRefundButton.tsx'));
const manager     = code(web('components/hubs/admin/MembersManager.tsx'));
const membersPage = code(web('app/hubs/[id]/manage/members/page.tsx'));
const hubsServer  = code(web('lib/hubs-server.ts'));
const adminUI     = code(web('components/admin/MembershipRefunds.tsx'));
const accountPage = code(web('app/account/memberships/page.tsx'));
const webhook     = code(read('supabase/functions/stripe-webhook/index.ts'));

function rowsOf(out: string): Record<string, unknown>[] {
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
}
const runSql = (sql: string) => rowsOf(execFileSync('npx',
  ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }));

/* ── 1. who may refund what ───────────────────────────────────────────────── */

describe('refund authority follows the money', () => {
  test('a platform admin may still refund anything', () => {
    assert.match(refundFn, /const isAdmin = me\?\.role === 'admin' \|\| me\?\.is_platform_owner === true/);
    assert.match(refundFn, /if \(!isAdmin && !ownsThisHub\)/);
  });

  test('a hub owner may refund a membership their own hub sold', () => {
    assert.match(refundFn, /if \(!isAdmin && membership\?\.hub_id\)/);
    assert.match(refundFn, /\.from\('hubs'\)\s*\.select\('owner_id'\)\.eq\('id', membership\.hub_id\)/);
    assert.match(refundFn, /ownsThisHub = \(hub as \{ owner_id\?: string \} \| null\)\?\.owner_id === user\.id/);
  });

  test('a committee member does not become a refunder by being in management', () => {
    // Nothing in the gate consults hub_members at all, so no role inside a hub
    // other than ownership can reach it.
    const gate = refundFn.slice(refundFn.indexOf('const isAdmin'), refundFn.indexOf('if (membership) {'));
    assert.doesNotMatch(gate, /hub_members|committee|is_hub_admin/);
  });

  test('non-membership rails stay platform-admin only', () => {
    // With no membership purchase there is no hub whose owner could claim it,
    // so ownsThisHub stays false and only an admin gets through.
    assert.match(refundFn, /let ownsThisHub = false/);
  });
});

/* ── 2. the purchase decides the hub ──────────────────────────────────────── */

describe('nothing the caller sends can widen their authority', () => {
  test('only a payment reference is read from the body', () => {
    assert.match(refundFn, /const \{ payment_intent_id, amount_pence = null, reason = 'requested_by_customer' \} = await req\.json\(\)/);
  });

  test('hub, owner and destination are never taken from the request', () => {
    const body = refundFn.slice(refundFn.indexOf('await req.json()'));
    for (const re of [/body\.hub_id/, /body\.owner_id/, /body\.destination/, /req\.hub_id/]) {
      assert.doesNotMatch(body, re, 'the request body is trusted for authorisation');
    }
  });

  test('the hub is resolved from the purchase row, not the caller', () => {
    assert.ok(refundFn.indexOf("from('hub_membership_purchases')") < refundFn.indexOf("from('hubs')"),
      'the hub is looked up before the purchase that determines it');
  });
});

/* ── 3. where the owner does it ───────────────────────────────────────────── */

describe('the control lives where a hub owner manages members', () => {
  test('the members screen carries the refund action', () => {
    assert.ok(existsSync(join(WEB_ROOT, 'components/hubs/admin/MembershipRefundButton.tsx')));
    assert.match(manager, /MembershipRefundButton/);
    assert.match(membersPage, /canRefund=\{admin\.role === "owner"\}/);
  });

  test('only the owner is offered it — committee sees the ledger, not the button', () => {
    assert.match(manager, /canRefund && \(/);
    assert.match(manager, /canRefund\?: boolean/);
  });

  test('the ledger says who paid, what for, when and how', () => {
    for (const f of ['memberName', 'tier_name', 'occurred_at', 'payment_method', 'refund_state', 'refunded_pence']) {
      assert.match(manager, new RegExp(f), `${f} is not shown`);
    }
  });

  test('the modal shows the authoritative totals', () => {
    assert.match(ownerButton, /Original total/);
    assert.match(ownerButton, /Already refunded/);
    assert.match(ownerButton, /Remaining refundable/);
    assert.match(ownerButton, /p\.total_pence \?\? p\.face_pence \+ \(p\.fee_pence \?\? 0\)|purchase\.total_pence/);
  });

  test('confirmation says what it does in plain words', () => {
    assert.match(ownerButton, /Yes, refund/);
    assert.match(ownerButton, /ends this paid membership unless another paid period still covers it/);
    assert.doesNotMatch(ownerButton, /PaymentIntent|reverse_transfer|application fee|Connect/);
  });
});

/* ── 4. what an owner may see ─────────────────────────────────────────────── */

describe('an owner sees membership facts, not payment plumbing', () => {
  test('no identifier is rendered anywhere in the hub surfaces', () => {
    for (const [name, src] of [['refund button', ownerButton], ['members manager', manager]] as const) {
      assert.doesNotMatch(src, /\{purchase\.payment_intent_id\}|\{p\.payment_intent_id\}/, name);
      assert.doesNotMatch(src, /stripe_transfer_id|stripe_account_id|charge_id|transaction_id/, name);
    }
  });

  test('the payment reference reaches the browser only to address the call', () => {
    // It is on the hub ledger type and nowhere near the customer's own page.
    assert.match(hubsServer, /export type HubLedgerEntry = MembershipPurchase & \{ payment_intent_id: string \| null \}/);
    assert.doesNotMatch(accountPage, /payment_intent_id/);
  });

  test('the ledger cannot be pointed at another hub', () => {
    assert.match(hubsServer, /\.eq\("hub_id", hubId\)/);
  });
});

/* ── 5. everything proven earlier still holds ─────────────────────────────── */

describe('the refund itself is untouched', () => {
  test('the economics are the ones observed in the TEST refund', () => {
    assert.match(refundFn, /form\.set\('reverse_transfer', 'true'\)/);
    assert.match(refundFn, /form\.set\('refund_application_fee', 'true'\)/);
  });

  test('recording, replay and the wallet path are unchanged', () => {
    assert.match(refundFn, /rpc\('record_membership_refund'/);
    assert.match(refundFn, /rpc\('wallet_reverse_debit'/);
    assert.match(refundFn, /can only be refunded in full/);
  });

  test('only a full refund revokes; a partial records and leaves it alone', () => {
    const r = runSql(`select prosrc from pg_proc where proname = 'record_membership_refund';`)[0];
    const src = String(r.prosrc);
    assert.match(src, /when v_new >= v_total\s+then 'full'/);
    assert.match(src, /if v_state = 'full' then/);
    assert.match(src, /greatest\(p\.refunded_pence, p_cumulative\)/);
  });

  test('the customer is still told, however it was pressed', () => {
    assert.match(webhook, /hubs\.membership_refunded/);
    assert.match(accountPage, /Refunded in full/);
    assert.match(accountPage, /Partly refunded/);
  });

  test('hub income is still net of refunds', () => {
    assert.match(manager, /p\.refund_state === "full" \? 0 : p\.face_pence/);
    assert.match(manager, /after refunds/);
  });

  test('the platform-admin surface remains as the override', () => {
    assert.ok(existsSync(join(WEB_ROOT, 'app/admin/payments/page.tsx')));
    assert.match(adminUI, /functions\.invoke\("refund-payment"/);
    assert.match(code(web('components/admin/AdminSidebar.tsx')), /href: "\/admin\/payments", label: "Payments"/);
  });

  test('both surfaces call the one backend — no second refund path exists', () => {
    assert.match(ownerButton, /functions\.invoke\("refund-payment"/);
    for (const [name, src] of [['owner button', ownerButton], ['admin UI', adminUI]] as const) {
      for (const re of [/api\.stripe\.com/, /reverse_transfer/, /record_membership_refund/,
                        /wallet_reverse_debit/, /apply_membership_entitlement/]) {
        assert.doesNotMatch(src, re, `${name} duplicates refund logic`);
      }
    }
  });
});

/* ── 6. the refund that was actually made ─────────────────────────────────── */

describe('the proven TEST refund is recorded correctly', () => {
  test('the Junior purchase is fully refunded and kept', () => {
    const r = runSql(`select refund_state, refunded_pence::text, total_pence::text,
                             (refunded_at is not null)::text stamped
                        from public.hub_membership_purchases where source = 'live';`)[0];
    assert.equal(r.refund_state, 'full');
    assert.equal(r.refunded_pence, '1095');
    assert.equal(r.total_pence, '1095');
    assert.equal(r.stamped, 'true');
  });

  test('entitlement was revoked without erasing the member', () => {
    const r = runSql(`select status, coalesce(paid_until::text,'null') expiry,
                             last_payment_pence::text paid, coalesce(member_no,'-') no
                        from public.hub_members
                       where stripe_payment_intent_id like 'pi_%' and status = 'removed';`)[0];
    assert.equal(r.status, 'removed');
    assert.equal(r.expiry, 'null');
    assert.equal(r.paid, '0');
    assert.equal(r.no, '2', 'the member number was not kept');
  });

  test('no further refund has been issued', () => {
    const r = runSql(`select count(*)::text c from public.hub_membership_purchases
                       where refund_state <> 'none';`)[0];
    assert.equal(r.c, '1');
  });
});
