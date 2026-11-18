#!/usr/bin/env node
// E5 webhook duplication and reconciliation. Creates two 25.00 participation payments (the second gets a 10.00 partial refund made at Stripe), WITHOUT delivering any event; then fetches the REAL events
// from `stripe get /v1/events` (this run's objects), and delivers them to the LOCAL editions-stripe-webhook signed with the local random secret:
//   payment 1: every event in order, each delivered TWICE  -> the second delivery must be a duplicate and change nothing;
//   payment 2: events delivered OUT OF ORDER (the refund before the payment), each twice -> the system must not corrupt state; whatever the refund event could not apply must be caught by reconcile.
// Then runs the cron `reconcile` action and the variance report and asserts the exceptions for THIS run are only the expected kinds.
// usage: node e5-webhooks-reconcile.mjs [--dry-run] [--allow FILE] [--account acct_...]
import { simulate, init, setup, payParticipation, dbPay, cron, fetchEvents, deliver, q, asUser, psql, finish, addRow, printTable, CARDS, gbp, hasType, readCharge, latestCharge } from './lib/common.mjs';
const run = await init('E5-webhooks-reconcile', process.argv);
await finish(run, async () => {
  const S = await setup(run, { acct: run.accounts[0] }); const C = 2500;
  const P1 = await payParticipation(run, S, { C, label: 'e5a', deliverEvents: false }); const P2 = await payParticipation(run, S, { C, label: 'e5b', deliverEvents: false });
  // Stripe-side activity not driven through the product path: the point of E5 is webhook handling, not the refund worker (E3 covers that)
  const ch1 = await run.api('POST', `/v1/payment_intents/${P1.pi}/confirm`, { data: [['payment_method', CARDS.uk.pm], ['return_url', 'https://example.test/return']], idempotencyKey: `${run.id}-c1` });
  const ch2 = await run.api('POST', `/v1/payment_intents/${P2.pi}/confirm`, { data: [['payment_method', CARDS.uk.pm], ['return_url', 'https://example.test/return']], idempotencyKey: `${run.id}-c2` });
  const settle = async (pi) => { let st = null; for (let i = 0; i < 10 && !run.dry; i++) { st = (await run.api('GET', `/v1/payment_intents/${pi}`)).body.status; if (st === 'succeeded') break; await new Promise((r) => setTimeout(r, 1500)); } return st; };
  const s1 = await settle(P1.pi), s2 = await settle(P2.pi); run.check('both payments succeeded at Stripe (status read back with GET after the confirm)', run.dry || (s1 === 'succeeded' && s2 === 'succeeded'), `${s1}/${s2}`);
  const rf = await run.api('POST', '/v1/refunds', { data: [['payment_intent', P2.pi], ['amount', '1000'], ['reverse_transfer', 'true'], ['refund_application_fee', 'false'], ['metadata[oneshetland_test_run]', run.id]], idempotencyKey: `${run.id}-r2` });
  run.check('partial refund of 10.00 made on payment 2', run.dry || rf.ok, rf.status);
  const need = (evs) => [P1.pi, P2.pi].every((p) => evs.some((e) => e.type === 'payment_intent.succeeded' && JSON.stringify(e.data.object).includes(p))) && evs.some((e) => e.type === 'charge.refunded');
  const evs = await fetchEvents(run, { wait: need, timeoutMs: 40000 });
  const mine = (pi) => evs.filter((e) => JSON.stringify(e.data?.object ?? {}).includes(pi));
  const e1 = mine(P1.pi), e2 = mine(P2.pi);
  console.log(`   fetched ${evs.length} real events (payment 1: ${e1.length}, payment 2: ${e2.length}): ${[...new Set(evs.map((e) => e.type))].join(', ')}`);
  run.warn('FINDING: events are in API version 2023-10-16 (account default arrives instead; known Stripe-side fact)', run.dry || (run.eventVersions ?? []).every((v) => v === '2023-10-16'), (run.eventVersions ?? []).join(','));
  run.check('real events found for both payments', run.dry || (e1.some((e) => e.type === 'payment_intent.succeeded') && e2.some((e) => e.type === 'charge.refunded')));
  const snap = (pi) => q(run, `select coalesce(status,'-') || '|' || refunded_pence || '|' || charge_pence || '|' || coalesce(stripe_fee_pence::text,'-') || '|' || coalesce(application_fee_actual_pence::text,'-') from edition_payments where stripe_payment_intent_id='${pi}'`);
  const webhookRows = () => Number(q(run, `select count(*) from edition_webhook_events`));

  console.log('\n-- payment 1: in order, every event twice');
  const log1 = [];
  for (const e of e1) { const a = await deliver(run, e); const s1 = snap(P1.pi); const b = await deliver(run, e); const s2 = snap(P1.pi); log1.push({ type: e.type, first: a.status, second: b.body.duplicate ? 'duplicate' : b.body.ignored ? 'ignored' : b.status });
    run.check(`${e.type}: first delivery HTTP 200; second is a duplicate or an ignore; the ledger row is unchanged by the repeat`, a.status === 200 && b.status === 200 && (b.body.duplicate === true || b.body.ignored !== undefined) && s1 === s2, `${a.status}/${b.status} ${JSON.stringify(b.body)} ${s1} -> ${s2}`); }
  const r1 = snap(P1.pi); run.check('payment 1 recorded once: succeeded, no refund, charge 2500, Stripe fee and actual application fee present', /^succeeded\|0\|2500\|\d+\|\d+$/.test(r1) || run.dry, r1);
  run.check('exactly one ledger row for payment 1', Number(q(run, `select count(*) from edition_payments where stripe_payment_intent_id='${P1.pi}'`)) === 1);

  console.log('\n-- payment 2: OUT OF ORDER (newest first), every event twice');
  const log2 = [];
  for (const e of [...e2].reverse()) { const a = await deliver(run, e); const b = await deliver(run, e); log2.push({ type: e.type, first: a.status, second: b.body.duplicate ? 'duplicate' : b.body.ignored ? 'ignored' : b.status }); run.check(`${e.type}: both deliveries accepted with HTTP 200`, a.status === 200 && b.status === 200, `${JSON.stringify(a.body)} / ${JSON.stringify(b.body)}`); }
  const r2 = snap(P2.pi); console.log(`   payment 2 ledger after out-of-order delivery: ${r2}   (Stripe says 1000 refunded)`);
  run.check('payment 2: no state corruption: row exists once, charge 2500', Number(q(run, `select count(*) from edition_payments where stripe_payment_intent_id='${P2.pi}'`)) === 1 && /\|2500\|/.test(r2) || run.dry, r2);
  const refundLanded = /^\w+\|1000\|/.test(r2);
  console.log(`   OBSERVED: the refund event that arrived BEFORE its payment ${refundLanded ? 'was applied' : 'was acknowledged but NOT applied (ledger refunded 0)'}; replaying that event id is a duplicate by design, so reconcile is the repair path`);
  const ids = [...e1, ...e2].map((e) => `'${e.id}'`).join(','); const rowsFor = ids ? Number(q(run, `select count(*) from edition_webhook_events where event_id in (${ids})`)) : 0;
  run.check('bookkeeping: each routed event id is recorded once (ledger events table has at most one row per delivered event id)', rowsFor <= new Set([...e1, ...e2].map((e) => e.id)).size, `rows ${rowsFor}`);

  console.log('\n-- reconcile (cron action) and variance report');
  const rc = await cron(run, 'reconcile', { days: 1 }); run.check(`cron reconcile ran (HTTP ${rc.status})`, rc.status === 200, JSON.stringify(rc.body));
  const mineRefs = [P1.pi, P2.pi]; const where = mineRefs.map((p) => `'${p}'`).join(',');
  const match = `(provider_ref in (${where}) or detail::text ~ '${P1.pi}|${P2.pi}')`;
  const rows = q(run, `select string_agg(kind || ':' || coalesce((select p from unnest(array[${where}]) p where provider_ref = p or detail::text like '%' || p || '%' limit 1), provider_ref), ',') from edition_reconciliation_exceptions where ${match}`);
  const kinds = (rows === '' ? [] : rows.split(',')).map((x) => x.split(':')); console.log(`   exceptions for THIS run's payments: ${rows || 'none'}`);
  for (const d of q(run, `select string_agg(kind || ' ' || detail::text, E'\n') from edition_reconciliation_exceptions where ${match}`).split('\n').filter(Boolean)) console.log(`     detail: ${d.slice(0, 300)}`);
  const other = q(run, `select count(*) from edition_reconciliation_exceptions where not ${match}`); console.log(`   other exceptions (charges from OTHER runs inside the 1-day window, informational): ${other}`);
  const p1Bad = kinds.filter(([k, ref]) => ref === P1.pi && k !== 'fee_variance');
  // Expected for payment 2 when its refund event arrived before the payment: missing_in_ledger (the early event found no payment) and, as a CONSEQUENCE of the same missed refund, refund_mismatch / transfer_mismatch
  // (Stripe's transfer was reversed by the refund's reverse_transfer, the ledger never saw the refund): one root cause, not a separate reconcile defect. Anything else is unexpected.
  const okP2 = refundLanded ? ['fee_variance'] : ['missing_in_ledger', 'refund_mismatch', 'transfer_mismatch', 'fee_variance'];
  const p2Bad = kinds.filter(([k, ref]) => ref === P2.pi && !okP2.includes(k));
  run.check('payment 1 has no exceptions other than an (optional) fee variance', p1Bad.length === 0, JSON.stringify(p1Bad));
  run.check('payment 2 has only the expected exceptions (missing_in_ledger / refund_mismatch / transfer_mismatch, all from the one early refund event; optional fee variance)', p2Bad.length === 0, `${JSON.stringify(p2Bad)} refundLanded ${refundLanded}`);
  const after = snap(P2.pi); run.check('REPAIR: after reconcile the ledger refunded total for payment 2 equals Stripe\'s 1000 (needs the reconcile refund-drift repair)', run.dry || /^\w+\|1000\|/.test(after), after);
  const vr = asUser(run, S.admin.id, `select count(*) from public.admin_edition_variance_report(now() - interval '1 day', now() + interval '1 day', 'month')`); console.log(`   variance report rows: ${vr}`);
  run.check('the admin variance report is readable and reflects this run', Number(vr) >= 1 || run.dry, vr);
  addRow(run, { ev1: e1.length, ev2: e2.length, dup1: log1.filter((l) => l.second === 'duplicate').length, ign1: log1.filter((l) => l.second === 'ignored').length, order2: log2.map((l) => l.type).join(' > '), refundLanded, exc: rows || 'none' });
  printTable(run, 'E5 webhook duplication and reconciliation', [{ h: 'events p1', f: (r) => r.ev1 }, { h: 'events p2', f: (r) => r.ev2 }, { h: 'p1 repeats = duplicate', f: (r) => r.dup1 }, { h: 'p1 repeats ignored (non-Edition type)', f: (r) => r.ign1 }, { h: 'p2 delivery order', f: (r) => r.order2 }, { h: 'refund applied out of order', f: (r) => r.refundLanded }, { h: 'exceptions', f: (r) => r.exc }]);
});
void simulate; void dbPay; void psql; void gbp; void hasType; void readCharge; void latestCharge;
