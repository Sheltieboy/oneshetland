/**
 * event-order-management.node.test.ts
 *
 * Organisers need to see who bought tickets and refund an order, on mobile and
 * web, WITHOUT a second refund system. This proves:
 *
 *   · the refund goes through the one canonical server path (refund-payment,
 *     addressed by order id) — the client never talks to Stripe, never sends a
 *     payment reference, and the server re-checks authority
 *   · that path keeps every hardening: reverse transfer, refund fee, refunded_by,
 *     idempotency, reconciliation, ticket void
 *   · Refund is offered only where the server says so, behind a confirmation that
 *     states the amount, purchaser, tickets and that they stop being valid
 *   · the mobile and web screens are wired, discoverable, and identical in wording
 *
 * The data-access matrix (who can see / refund, no leaks, tickets void once) is
 * proved against real Postgres in event-orders-access.node.test.ts.
 *
 * Nothing here moves money, creates a user, or touches any real order.
 */

import './_support/production-lane-guard.ts';   // fail closed: this file can contact production (see that module)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  pounds, purchaserLabel, ticketSummary, orderStatusBadge, checkedInLabel, ticketStatusLabel, refundConfirmation, paymentMethodLabel,
  type OrderLike,
} from '../../lib/event-orders-utils.ts';
import * as webUtils from '../../../oneshetland-web/lib/event-orders-utils.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

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

const order = (over: Partial<OrderLike> = {}): OrderLike => ({
  id: 'abcd1234-0000-4000-8000-000000000000', status: 'paid', total_pence: 196, tickets_count: 1, checked_in_count: 0,
  purchaser: { name: 'Sam Buyer', email: 'sam@example.com' },
  tickets: [{ ticket_type: 'Standard', status: 'valid', checked_in_at: null }],
  ...over,
});

/* ── 1. The refund path: one canonical function, addressed by order id ───── */

describe('refunds use the canonical server path, not a second system', () => {
  const fn = code(read('supabase/functions/refund-payment/index.ts'));

  test('an event ticket order is refunded through refund-payment by ORDER id, resolved to its payment server-side', () => {
    assert.match(fn, /boost_purchase_id = null, event_order_id = null \} = body/);
    assert.match(fn, /\.from\('event_ticket_orders'\)[\s\S]{0,200}\.eq\('id', event_order_id\)/);
    assert.match(fn, /payment_intent_id = eventOrder\.stripe_payment_intent_id;/);
  });

  test('authority is checked BEFORE anything about the order is revealed, through the single shared predicate', () => {
    const authAt = fn.indexOf("svc.rpc('can_refund_event_orders'");
    const statusAt = fn.indexOf("already been refunded");
    assert.ok(authAt > 0 && statusAt > authAt, 'a caller who may not refund must not learn the order state');
    assert.match(fn, /if \(!eventOrder \|\| !ownsThisEvent\) \{/);
    assert.match(fn, /Forbidden — only the organiser who received this payment, or OneShetland, can refund it\./);
  });

  test('a ticket order is refunded IN FULL only, and only while paid and not already refunded', () => {
    assert.match(fn, /A ticket order is refunded in full\./);
    assert.match(fn, /eventOrder\.status === 'refunded' \|\| eventOrder\.refunded_at/);
    assert.match(fn, /This order has already been refunded\./);
    assert.match(fn, /eventOrder\.status !== 'paid' \|\| !eventOrder\.stripe_payment_intent_id \|\| !\(eventOrder\.total_pence > 0\)/);
  });

  test('the platform-admin-only rule is unchanged for a bare payment_intent_id: tickets are NOT refundable by an organiser that way', () => {
    assert.match(fn, /if \(!isAdmin && !ownsThisHub && !ownsThisEvent\) \{/);
    // ownsThisEvent can only become true inside the event_order_id branch.
    const assigns = [...fn.matchAll(/ownsThisEvent = /g)].length;
    assert.equal(assigns, 2, 'ownsThisEvent is declared false and set exactly once, from the shared predicate');
    assert.match(fn, /ownsThisEvent = ok === true;/);
  });

  test('every hardening on the canonical path is still there: reverse transfer, fee refund, refunded_by, idempotency, reconciliation', () => {
    assert.match(fn, /form\.set\('reverse_transfer', 'true'\)/);
    assert.match(fn, /form\.set\('refund_application_fee', 'true'\)/);
    assert.match(fn, /form\.set\('metadata\[refunded_by\]', user\.id\)/);
    assert.match(fn, /metadata\[event_order_id\]/);
    assert.match(fn, /const idemKey = `refund:\$\{payment_intent_id\}:\$\{amount \?\? 'full'\}`;/);
    assert.match(fn, /'Idempotency-Key': idemKey/);
    assert.match(fn, /reconcileCharge\(svc, chargeId/);
    assert.match(fn, /This payment is already fully refunded\./);
  });

  test('after the refund the SAME idempotent ticket-void the webhook uses is applied, so the order is right immediately', () => {
    assert.match(fn, /svc\.rpc\('refund_event_tickets_for_payment',\s*\{ p_payment_intent_id: payment_intent_id, p_fully_refunded: true \}\)/);
    const refundAt = fn.indexOf("fetch(`${STRIPE}/refunds`");
    // The CARD path's own void call (the last one); the Wallet deps above serve() are a different rail.
    const voidAt = fn.lastIndexOf("svc.rpc('refund_event_tickets_for_payment'");
    assert.ok(refundAt > 0 && voidAt > refundAt, 'tickets are voided only AFTER Stripe accepted the refund');
  });

  test('one of event_order_id / boost_purchase_id; the id must look like an id', () => {
    assert.match(fn, /Send one of event_order_id or boost_purchase_id/);
    assert.match(fn, /event_order_id must be an id/);
  });

  test('the webhook still voids tickets on charge.refunded (Dashboard refunds, retries) — both paths converge on one RPC', () => {
    const wh = code(read('supabase/functions/stripe-webhook/index.ts'));
    assert.match(wh, /'refund_event_tickets_for_payment',\s*\{ p_payment_intent_id: pi, p_fully_refunded: fullyRefunded \}/);
  });
});

/* ── 2. The clients never refund directly ─────────────────────────────────── */

describe('neither client can refund directly or see a Stripe reference', () => {
  const api = code(read('lib/events-api.ts'));
  const screen = code(read('app/event-orders.tsx'));
  const webComp = code(readWeb('components/events/EventOrders.tsx'));

  test('mobile: the refund is exactly refund-payment with { event_order_id }, and nothing else', () => {
    const fnBody = api.slice(api.indexOf('export async function refundEventOrder'), api.indexOf('export async function purchaseTickets'));
    assert.ok(fnBody.length > 200 && fnBody.length < 1500, 'sliced the wrong region');
    assert.match(fnBody, /supabase\.functions\.invoke\('refund-payment', \{\s*body: \{ event_order_id: orderId \},/);
    assert.doesNotMatch(fnBody, /payment_intent|api\.stripe\.com|amount_pence|\.from\(/);
  });

  test('web: the refund is exactly refund-payment with { event_order_id }, and nothing else', () => {
    const refundFn = webComp.slice(webComp.indexOf('async function refund(order: Order)'), webComp.indexOf('if (!data && !error)'));
    assert.ok(refundFn.length > 300 && refundFn.length < 2500, 'sliced the wrong region');
    assert.match(refundFn, /functions\.invoke\("refund-payment", \{ body: \{ event_order_id: order\.id \} \}\)/);
    assert.doesNotMatch(refundFn, /payment_intent|api\.stripe\.com|amount_pence|\.from\(/);
  });

  test('no client writes event orders or tickets itself', () => {
    const organiserApi = api.slice(api.indexOf('export interface OrganiserOrderTicket'), api.indexOf('export async function purchaseTickets'));
    assert.ok(organiserApi.length > 1500, 'sliced the wrong region');
    for (const src of [organiserApi, screen, webComp]) {
      assert.doesNotMatch(src, /event_ticket_orders'\)\s*\.(update|insert|delete|upsert)|event_tickets'\)\s*\.(update|insert|delete|upsert)/);
    }
  });

  test('the list comes only from get_event_orders on both clients (the one function that refuses unauthorised callers)', () => {
    assert.match(api, /supabase\.rpc\('get_event_orders', \{ p_event_id: eventId \}\)/);
    assert.match(webComp, /rpc\("get_event_orders", \{ p_event_id: eventId \}\)/);
  });

  test('mobile and web never display the payment reference unless the server returned it (admins only)', () => {
    assert.match(screen, /isAdmin && order\.payment_intent_id/);
    assert.match(webComp, /data\.is_admin && o\.payment_intent_id/);
  });
});

/* ── 3. Refund is offered only where the server says so, behind a clear confirmation ─ */

describe('Refund is gated by the server flag and confirmed before money moves', () => {
  const screen = code(read('app/event-orders.tsx'));
  const webComp = code(readWeb('components/events/EventOrders.tsx'));

  test('mobile: the Refund button renders only when order.refundable; otherwise a note or nothing', () => {
    assert.match(screen, /: order\.refundable \? \(\s*<TouchableOpacity/);
    assert.match(screen, /Refund order/);
    assert.match(screen, /Only the business owner, or OneShetland, can refund this order\./);
    assert.doesNotMatch(screen, /canRefundAny \?[\s\S]{0,80}Refund order/, 'the button must hang off the per-order flag, not the viewer flag');
  });

  test('web: the Refund button renders only when o.refundable', () => {
    assert.match(webComp, /\{o\.refundable \? \(\s*<button/);
    assert.match(webComp, /Refund order/);
  });

  test('mobile: tapping "Refund order" only OPENS the inline confirmation; the refund runs only from the confirmation\'s own button', () => {
    // Refund order -> onAskRefund -> step 'confirm'. It must not call the server itself.
    assert.match(screen, /onAskRefund=\{\(\) => \{ setMessage\(null\); setStep\('confirm'\); \}\}/);
    const askFn = screen.slice(screen.indexOf('onAskRefund={'), screen.indexOf('onAskRefund={') + 120);
    assert.doesNotMatch(askFn, /refundEventOrder|doRefund/);
    // The ONLY caller of doRefund is the confirmation's confirm handler.
    assert.match(screen, /const doRefund = async \(order: OrganiserOrder\)/);
    assert.equal((screen.match(/doRefund\(/g) ?? []).length, 1, 'called from exactly one place');
    assert.match(screen, /onConfirmRefund=\{\(\) => doRefund\(selected\)\}/);
    assert.match(screen, /onPress=\{onConfirm\}/);
  });

  test('mobile: the confirmation is shown INLINE and carries the exact refundConfirmation wording', () => {
    const panel = screen.slice(screen.indexOf('function ConfirmPanel'), screen.indexOf('function Row('));
    assert.match(panel, /const c = refundConfirmation\(order\);/);
    assert.match(panel, /\{c\.title\}/); assert.match(panel, /\{c\.message\}/); assert.match(panel, /\{c\.confirmLabel\}/);
    assert.match(screen, /step === 'confirm' \|\| working \? \(\s*<ConfirmPanel/);
  });

  test('mobile: ROOT CAUSE REGRESSION — the screen uses no React Native Modal and no root alert, which iOS silently swallows over a modal', () => {
    // The first version opened the order in a <Modal> and confirmed via the app-root alert (also a Modal).
    // iOS cannot present a second modal over a presented one, so "Refund order" did nothing at all.
    assert.doesNotMatch(screen, /<Modal\b/);
    assert.doesNotMatch(screen, /\bModal\b/);
    assert.doesNotMatch(screen, /useAlert|\balert\(/);
    assert.doesNotMatch(screen, /Alert\.alert/);
    assert.match(screen, /\.\.\.StyleSheet\.absoluteFillObject/, 'the order sheet is an in-screen overlay');
    // The documented trap, so the next person finds it.
    assert.match(read('app/event-orders.tsx'), /iOS cannot present a second modal over a presented one/);
  });

  test('mobile: the result and any error are shown INLINE too, and a repeated tap cannot start a second refund', () => {
    assert.match(screen, /step === 'done' \? \(/);
    assert.match(screen, /step === 'error' \? \(/);
    assert.match(screen, /Refund not completed/);
    // A ref guard (state would let two taps in the same frame through) plus disabled controls.
    assert.match(screen, /const refundingRef = useRef\(false\);/);
    assert.match(screen, /if \(refundingRef\.current\) return;\s*refundingRef\.current = true;/);
    assert.match(screen, /finally \{\s*refundingRef\.current = false;/);
    assert.match(screen, /disabled=\{working\}/);
    assert.match(screen, /disabled=\{working\} onPress=\{onCancel\}|disabled=\{working\} activeOpacity/);
  });

  test('mobile: the sheet cannot be dismissed while a refund is in flight', () => {
    assert.match(screen, /const close = \(\) => \{ if \(!refundingRef\.current\)/);
  });

  test('web: confirmation first (danger), and a busy guard against a second click', () => {
    const c = webComp.indexOf('await confirm({');
    const call = webComp.indexOf('functions.invoke("refund-payment"');
    assert.ok(c > 0 && call > c);
    assert.match(webComp, /danger: true/);
    assert.match(webComp, /if \(refunding\) return;/);
    assert.match(webComp, /disabled=\{refunding\}/);
    assert.match(webComp, /if \(!ok\) return;/);
  });

  test('the confirmation states the amount, the purchaser, the tickets, and that they stop being valid', () => {
    const c = refundConfirmation(order({ total_pence: 196, tickets_count: 2, tickets: [
      { ticket_type: 'Standard', status: 'valid', checked_in_at: null }, { ticket_type: 'Standard', status: 'valid', checked_in_at: null }] }));
    assert.equal(c.title, 'Refund this order?');
    assert.match(c.message, /refund £1\.96 to Sam Buyer \(sam@example\.com\)/);
    assert.match(c.message, /Tickets: 2 × Standard\./);
    assert.match(c.message, /All 2 tickets in this order will no longer be valid and cannot be used to enter\./);
    assert.match(c.message, /cannot be undone/);
    assert.equal(c.confirmLabel, 'Refund £1.96');
  });

  test('a single ticket and an unnamed purchaser read correctly', () => {
    const c = refundConfirmation(order({ purchaser: { name: null, email: 'kim@example.com' } }));
    assert.match(c.message, /refund £1\.96 to kim@example\.com/);
    assert.match(c.message, /The ticket will no longer be valid and cannot be used to enter\./);
    assert.match(refundConfirmation(order({ purchaser: { name: null, email: null } })).message, /to the purchaser/);
  });

  test('already-used tickets are called out, because the whole order is still refunded', () => {
    const c = refundConfirmation(order({ tickets_count: 2, checked_in_count: 1 }));
    assert.match(c.message, /1 ticket has already been checked in; that attendance stays on record, but the money for the whole order is still refunded\./);
    assert.match(refundConfirmation(order({ tickets_count: 3, checked_in_count: 2 })).message, /2 tickets have already been checked in/);
  });
});

/* ── 3b. A Wallet-funded order's confirmation says where the money goes ───── */

describe('Wallet-funded orders: the confirmation names the Wallet, the card wording is unchanged', () => {
  const wallet = (over: Partial<OrderLike> = {}) => order({ payment_method: 'wallet', ...over });

  test('the exact Wallet confirmation: £ amount, purchaser, ticket, money returns to their OneShetland Wallet, ticket no longer valid', () => {
    const c = refundConfirmation(wallet({
      purchaser: { name: 'James Fullerton', email: 'darren@oneshetland.com' },
      tickets: [{ ticket_type: 'TEST — Paid Entry', status: 'valid', checked_in_at: null }],
    }));
    assert.equal(c.title, 'Refund this order?');
    assert.match(c.message, /refund £1\.96 to James Fullerton \(darren@oneshetland\.com\)/);
    assert.match(c.message, /Tickets: 1 × TEST — Paid Entry\./);
    assert.match(c.message, /They paid with their OneShetland Wallet, so the £1\.96 goes back into their Wallet balance — not to a card\./);
    assert.match(c.message, /The ticket will no longer be valid and cannot be used to enter\./);
    assert.equal(c.confirmLabel, 'Refund £1.96');
  });

  test('a card order does NOT mention a Wallet, and a Wallet order is the only one that does', () => {
    assert.doesNotMatch(refundConfirmation(order({ payment_method: 'card' })).message, /Wallet/);
    assert.doesNotMatch(refundConfirmation(order()).message, /Wallet/, 'an order with no stated rail reads as the card wording');
    assert.match(refundConfirmation(wallet()).message, /Wallet/);
  });

  test('how it was paid is shown to the organiser', () => {
    assert.equal(paymentMethodLabel({ payment_method: 'wallet', total_pence: 196 }), 'OneShetland Wallet');
    assert.equal(paymentMethodLabel({ payment_method: 'card', total_pence: 196 }), 'Card');
    assert.equal(paymentMethodLabel({ payment_method: 'free', total_pence: 0 }), 'Free');
  });

  test('both clients carry payment_method from the server and show it; the success message is Wallet-aware', () => {
    assert.match(read('lib/events-api.ts'), /payment_method:\s+'wallet' \| 'card' \| 'free';/);
    const screen = code(read('app/event-orders.tsx'));
    assert.match(screen, /Row label="Paid with" value=\{paymentMethodLabel\(order\)\}/);
    assert.match(screen, /order\.payment_method === 'wallet'\s*\? `\$\{pounds\(order\.total_pence\)\} has been returned to \$\{purchaserLabel\(order\)\}'s OneShetland Wallet/);
    const web = code(readWeb('components/events/EventOrders.tsx'));
    assert.match(web, /Row k="Paid with" v=\{paymentMethodLabel\(o\)\}/);
    assert.match(web, /order\.payment_method === "wallet"/);
  });
});

/* ── 4. What the organiser reads: statuses never mislead ──────────────────── */

describe('order presentation', () => {
  test('a refunded order is never shown as merely paid; free and paid are distinct', () => {
    assert.deepEqual(orderStatusBadge({ status: 'refunded', total_pence: 196 }), { label: 'Refunded', tone: 'danger' });
    assert.deepEqual(orderStatusBadge({ status: 'paid', total_pence: 196 }), { label: 'Paid', tone: 'ok' });
    assert.deepEqual(orderStatusBadge({ status: 'paid', total_pence: 0 }), { label: 'Free', tone: 'muted' });
  });

  test('tickets are summarised by type, money as pounds, check-in only when relevant', () => {
    assert.equal(ticketSummary(order({ tickets: [
      { ticket_type: 'Standard', status: 'valid', checked_in_at: null }, { ticket_type: 'VIP', status: 'valid', checked_in_at: null },
      { ticket_type: 'Standard', status: 'valid', checked_in_at: null }], tickets_count: 3 })), '2 × Standard, 1 × VIP');
    assert.equal(pounds(196), '£1.96');
    assert.equal(checkedInLabel({ checked_in_count: 0, tickets_count: 2 }), null);
    assert.equal(checkedInLabel({ checked_in_count: 1, tickets_count: 2 }), '1 of 2 checked in');
    assert.equal(purchaserLabel({ purchaser: { name: ' ', email: 'x@y.z' } }), 'x@y.z');
  });

  test('a refunded ticket reads as void', () => {
    assert.equal(ticketStatusLabel('refunded'), 'Void — refunded');
    assert.equal(ticketStatusLabel('used'), 'Checked in');
  });
});

/* ── 5. Discoverable on both clients, same wording ────────────────────────── */

describe('discoverable from the existing organiser screens', () => {
  test('mobile: "Ticket orders" sits in the existing Actions grid and opens the orders screen for THIS event', () => {
    const manage = code(read('app/event-manage.tsx'));
    const grid = manage.slice(manage.indexOf('actionsGrid'), manage.indexOf('Post update form'));
    assert.match(grid, /icon="ticket-alt" label="Ticket orders"/);
    assert.match(grid, /pathname: '\/event-orders', params: \{ id: event\.id \}/);
    // beside the existing actions, not in a new section
    for (const existing of ['Scan tickets', 'Edit event', 'Post update']) assert.ok(grid.includes(existing), existing);
    assert.ok(existsSync(join(REPO_ROOT, 'app/event-orders.tsx')));
  });

  test('mobile screen shows what an organiser needs: purchaser name and email, ticket types, amount, date, status, check-in, refund state', () => {
    const screen = code(read('app/event-orders.tsx'));
    for (const needle of ['purchaserLabel(o)', 'o.purchaser.email', 'ticketSummary(o)', 'pounds(o.total_pence)', 'formatEventDate(o.paid_at ?? o.created_at)',
      'orderStatusBadge(o)', 'checkedInLabel(o)', 'Refunded {formatEventDate(o.refunded_at)}']) {
      assert.ok(screen.includes(needle), `missing ${needle}`);
    }
    assert.match(screen, /onPress=\{\(\) => open\(o\.id\)\}/);   // selecting an order opens its detail
    assert.match(screen, /ticketStatusLabel\(t\.status\)/);
  });

  test('web: business and hub routes exist, are gated by the existing owner/admin guards, and are linked from the event screens', () => {
    const biz = readWeb('app/business/[id]/manage/events/[eventId]/orders/page.tsx');
    assert.match(biz, /requireBusinessOwner\(id\)/);
    assert.match(biz, /getBusinessEvent\(business\.id, eventId\)/);
    assert.match(biz, /<EventOrders eventId=\{event\.id\} \/>/);
    const hub = readWeb('app/hubs/[id]/manage/events/[eventId]/orders/page.tsx');
    assert.match(hub, /requireHubAdmin\(id\)/);
    assert.match(hub, /events\.find\(\(e\) => e\.id === eventId\)/);
    assert.match(readWeb('components/business/BusinessEventManage.tsx'), /href=\{`\$\{base\}\/\$\{event\.id\}\/orders`\}[^>]*>Ticket orders</);
    assert.match(readWeb('components/hubs/admin/EventsManager.tsx'), /\/hubs\/\$\{hubId\}\/manage\/events\/\$\{ev\.id\}\/orders/);
  });

  test('the mobile and web helper files are byte-identical, so both clients show the same refund confirmation', () => {
    assert.equal(read('lib/event-orders-utils.ts'), readWeb('lib/event-orders-utils.ts'));
    const o = order({ tickets_count: 2, checked_in_count: 1 });
    assert.deepEqual(webUtils.refundConfirmation(o), refundConfirmation(o));
  });
});

/* ── 6. Live, read-only ───────────────────────────────────────────────────── */

describe('live (read-only): the functions are installed with the intended grants', () => {
  test('get_event_orders and can_refund_event_orders exist as SECURITY DEFINER', () => {
    const rows = sql(`select proname, prosecdef from pg_proc where pronamespace = 'public'::regnamespace and proname in ('get_event_orders','can_refund_event_orders') order by 1;`);
    assert.deepEqual(rows.map((r) => [r.proname, r.prosecdef]), [['can_refund_event_orders', true], ['get_event_orders', true]]);
  });

  test('grants: clients may call get_event_orders (signed in only); the refund predicate is server-only', () => {
    const [g] = sql(`select
        has_function_privilege('anon','public.get_event_orders(uuid)','execute') as anon_view,
        has_function_privilege('authenticated','public.get_event_orders(uuid)','execute') as auth_view,
        has_function_privilege('anon','public.can_refund_event_orders(uuid,uuid)','execute') as anon_can,
        has_function_privilege('authenticated','public.can_refund_event_orders(uuid,uuid)','execute') as auth_can,
        has_function_privilege('service_role','public.can_refund_event_orders(uuid,uuid)','execute') as svc_can;`);
    assert.deepEqual([g.anon_view, g.auth_view, g.anon_can, g.auth_can, g.svc_can], [false, true, false, false, true]);
  });

  test('the deployed view function refuses before reading and uses the existing can_scan_event authority', () => {
    const [d] = sql(`select pg_get_functiondef('public.get_event_orders(uuid)'::regprocedure) as def;`);
    const def = String(d.def);
    assert.match(def, /can_scan_event\(p_event_id, v_uid\)/);
    assert.match(def, /42501/);
  });
});
