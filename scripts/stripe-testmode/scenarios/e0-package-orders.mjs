#!/usr/bin/env node
// E0 package orders: Launch (24900) and Showcase (49900) through the REAL create-edition-checkout path.
//   expects: PaymentIntent with NO transfer and NO application fee; succeeds with a UK test card; webhook fulfilment activates entitlement/rights; a platform-only refund voids them.
// usage: node e0-package-orders.mjs [--dry-run] [--allow FILE] [--account acct_...]   (a connected account is not needed by package orders; none is picked)
import { simulate, init, setup, checkout, cron, sync, hasType, confirmPi, latestCharge, readCharge, asUser, q, sql, finish, addRow, printTable, CARDS, gbp } from './lib/common.mjs';
const run = await init('E0-package-orders', process.argv, { needsAccount: false });
await finish(run, async () => {
  const S = await setup(run, { acct: `acct_unused${run.id.slice(-4)}`, memberships: true });   // package orders never touch the connected account
  for (const [code, price] of [['launch', 24900], ['showcase', 49900]]) {
    console.log(`\n-- ${code} ${gbp(price)}`);
    const ed = S.newEdition(`pkg-${code}`, false);
    const pkg = q(run, `select id from edition_packages where code='${code}'`);
    const order = asUser(run, S.owner.id, `select public.edition_create_order('${S.org}','${ed}','${pkg}','attempt-${run.id.slice(-6)}-${code}-1')`);
    const amt = Number(q(run, `select amount_pence from edition_orders where id='${order}'`)); run.check(`${code}: the stored order price is ${price}`, amt === price, `db ${amt}`);
    const co = await checkout(run, S.owner, { kind: 'order', id: order, attempt: `attempt-${run.id.slice(-6)}-${code}-1` });
    run.check(`${code}: checkout returned a client secret and a PaymentIntent (HTTP ${co.status})`, co.status === 200 && co.body.payment_intent_id);
    const pi = co.body.payment_intent_id; const piObj = (await run.api('GET', `/v1/payment_intents/${pi}`)).body;
    run.check(`${code}: PaymentIntent amount is ${price}, NO transfer_data, NO application fee`, piObj.amount === price && !piObj.transfer_data && !piObj.application_fee_amount, `amount ${piObj.amount} transfer ${JSON.stringify(piObj.transfer_data)} fee ${piObj.application_fee_amount}`);
    run.check(`${code}: metadata kind edition_order and the run tag`, piObj.metadata?.kind === 'edition_order' && piObj.metadata?.oneshetland_test_run === run.id);
    const c = await confirmPi(run, pi, CARDS.uk.pm); run.check(`${code}: payment succeeds with the UK test card`, c.status === 'succeeded', c.status);
    await sync(run, hasType(['payment_intent.succeeded']));
    await simulate(run, 'payment_intent.succeeded', { id: pi, object: 'payment_intent', amount: price, amount_received: price, latest_charge: 'ch_sim_' + code, metadata: { kind: 'edition_order', order_id: order, organiser_id: S.org, edition_id: ed, buyer_id: S.owner.id } });
    run.check(`${code}: webhook fulfilment marked the order paid`, q(run, `select status from edition_orders where id='${order}'`) === 'paid');
    run.check(`${code}: rights are active (edition entitlements not voided)`, Number(q(run, `select count(*) from edition_entitlements where order_id='${order}' and voided_at is null`)) + Number(q(run, `select count(*) from edition_organiser_entitlements where order_id='${order}' and voided_at is null`)) > 0);
    const ch = await readCharge(run, (await latestCharge(run, pi)) ?? 'ch_123');
    run.check(`${code}: the charge has no application fee and no transfer (platform keeps it all)`, !ch.app_fee && !ch.transfer && !ch.application_fee_amount);
    // platform-only refund through the product path: administrator request -> cron -> Stripe refund -> webhook
    asUser(run, S.admin.id, `select public.admin_request_edition_order_refund('${order}', null, 'ZZ E0 test refund')`);
    const cr = await cron(run, 'refunds'); run.check(`${code}: cron refunds ran (HTTP ${cr.status})`, cr.status === 200 && cr.body.submitted >= 1, JSON.stringify(cr.body));
    const refunds = (await run.api('GET', '/v1/refunds', { query: [['payment_intent', pi]] })).body.data ?? [];
    run.check(`${code}: ONE Stripe refund for the full ${price}, no transfer reversal`, refunds.length === 1 && refunds[0].amount === price && !refunds[0].transfer_reversal, JSON.stringify(refunds.map((r) => [r.amount, r.transfer_reversal])));
    await sync(run, hasType(['charge.refunded']));
    await simulate(run, 'charge.refunded', { id: 'ch_sim_' + code, object: 'charge', payment_intent: pi, amount: price, amount_refunded: price, metadata: { kind: 'edition_order', order_id: order } });
    run.check(`${code}: order refunded and rights voided`, q(run, `select status from edition_orders where id='${order}'`) === 'refunded' && Number(q(run, `select count(*) from edition_entitlements where order_id='${order}' and voided_at is null`)) === 0);
    addRow(run, { code, price, piAmount: piObj.amount, appFee: ch.application_fee_amount ?? 0, transfer: ch.transfer ? 'yes' : 'none', S: ch.fee, refund: refunds[0]?.amount });
  }
  printTable(run, 'E0 package orders', [{ h: 'package', f: (r) => r.code }, { h: 'model price', f: (r) => gbp(r.price) }, { h: 'PI amount', f: (r) => gbp(r.piAmount) }, { h: 'model app fee', f: () => '0.00' }, { h: 'measured app fee', f: (r) => gbp(r.appFee) }, { h: 'transfer', f: (r) => r.transfer }, { h: 'Stripe fee S (platform)', f: (r) => gbp(r.S) }, { h: 'refund', f: (r) => gbp(r.refund) }]);
});
