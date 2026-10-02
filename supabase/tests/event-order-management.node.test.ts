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

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  pounds, purchaserLabel, ticketSummary, orderStatusBadge, checkedInLabel, ticketStatusLabel, refundConfirmation,
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
    const voidAt = fn.indexOf("svc.rpc('refund_event_tickets_for_payment'");
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
    assert.match(screen, /\{order\.refundable \? \(\s*<TouchableOpacity/);
    assert.match(screen, /Refund order/);
    assert.match(screen, /Only the business owner, or OneShetland, can refund this order\./);
    assert.doesNotMatch(screen, /canRefundAny \?[\s\S]{0,80}Refund order/, 'the button must hang off the per-order flag, not the viewer flag');
  });

  test('web: the Refund button renders only when o.refundable', () => {
    assert.match(webComp, /\{o\.refundable \? \(\s*<button/);
    assert.match(webComp, /Refund order/);
  });

  test('mobile: confirmation comes first, is not dismissible by a stray tap, and the refund runs only from its destructive button', () => {
    const c = screen.indexOf('refundConfirmation(order)');
    const call = screen.indexOf('await refundEventOrder(order.id)');
    assert.ok(c > 0 && call > c);
    assert.match(screen, /dismissible: false/);
    assert.match(screen, /style: 'destructive'/);
    assert.match(screen, /if \(refunding\) return;/, 'a second tap must not start a second refund');
    assert.match(screen, /disabled=\{refunding\}/);
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
    assert.match(screen, /setSelectedId\(o\.id\)/);   // selecting an order opens its detail
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
