#!/usr/bin/env node
// E1 participation payments: 25.00 and 100.00, UK card 4000008260000000 and international card 4000000760000002 (via Stripe's test tokens pm_card_gb / pm_card_br).
//   Real create-edition-checkout -> destination charge. Reads the PLATFORM balance_transaction fee and fee_details, the application fee object and the transfer; compares with the model
//   (commission 2% + estimated recovery) and records the variance; confirms no extra amount is added for the customer.
// usage: node e1-participation.mjs [--dry-run] [--allow FILE] [--account acct_...]
import { simulate, init, setup, checkout, sync, hasType, confirmPi, latestCharge, readCharge, q, finish, addRow, printTable, feeParts, CFG, CARDS, ASSUMED_S, gbp, onCleanup } from './lib/common.mjs';
const run = await init('E1-participation', process.argv);
await finish(run, async () => {
  const S = await setup(run, { acct: run.accounts[0] });
  for (const C of [2500, 10000]) for (const card of ['uk', 'intl']) {
    console.log(`\n-- ${gbp(C)} with the ${card === 'uk' ? 'UK' : 'international'} card (${CARDS[card].number})`);
    const { payer, link, edition } = await S.newLink(C, `${C}-${card}`); const model = feeParts(C, CFG);
    const co = await checkout(run, payer, { kind: 'participation', id: link, attempt: `attempt-${run.id.slice(-6)}-${C}-${card}` });
    run.check('checkout accepted (HTTP 200) and charge_pence equals the price', co.status === 200 && co.body.charge_pence === C, `${co.status} ${JSON.stringify(co.body).slice(0, 120)}`);
    const pi = co.body.payment_intent_id; const po = (await run.api('GET', `/v1/payment_intents/${pi}`)).body;
    if (po.customer) onCleanup(run, `customer ${po.customer}`, () => run.api('DELETE', `/v1/customers/${po.customer}`));
    run.check(`PaymentIntent: amount ${C} exactly (nothing added for the customer), application fee ${model.fee}, destination ${S.acct}`, po.amount === C && po.application_fee_amount === model.fee && (po.transfer_data?.destination === S.acct), `amount ${po.amount} fee ${po.application_fee_amount} dest ${po.transfer_data?.destination}`);
    const c = await confirmPi(run, pi, CARDS[card].pm); run.check('payment succeeds', c.status === 'succeeded', c.status);
    await sync(run, hasType(['payment_intent.succeeded', 'charge.succeeded']));
    await simulate(run, 'payment_intent.succeeded', { id: pi, object: 'payment_intent', amount: C, amount_received: C, latest_charge: 'ch_sim_1', metadata: { kind: 'edition_participation', link_id: link, organiser_id: S.org, business_id: payer.biz, edition_id: edition, buyer_id: payer.id } });
    const ch = await readCharge(run, (await latestCharge(run, pi)) ?? 'ch_123');
    run.check('the charge is exactly the price; the transfer is the FULL charge; the application fee object equals the PaymentIntent fee', ch.amount === C && ch.transfer?.amount === C && ch.app_fee?.amount === model.fee, `charge ${ch.amount} transfer ${ch.transfer?.amount} appfee ${ch.app_fee?.amount}`);
    const S_actual = ch.fee, S_model = ASSUMED_S[CARDS[card].model](C), variance = S_actual == null ? null : model.recovery - S_actual;
    const row = q(run, `select coalesce(stripe_fee_pence::text,'-') || '|' || coalesce(application_fee_actual_pence::text,'-') || '|' || coalesce(recovery_variance_pence::text,'-') || '|' || commission_pence || '|' || recovery_estimate_pence || '|' || charge_pence from edition_payments where stripe_payment_intent_id='${pi}'`).split('|');
    run.check('ledger row: parts, actual application fee and Stripe fee recorded; variance = estimate - actual', row.length === 6 && Number(row[3]) === model.commission && Number(row[4]) === model.recovery && Number(row[1]) === model.fee && Number(row[0]) === S_actual && Number(row[2]) === variance, row.join('|'));
    addRow(run, { C, card, F_model: model.fee, F_act: ch.application_fee_amount, comm: model.commission, rec: model.recovery, S_model, S_act: S_actual, details: (ch.fee_details ?? []).map((d) => `${d.type}:${d.amount}`).join(','), variance, vs_model: S_actual == null ? null : S_actual - S_model, org_net: C - model.fee, org_net_actual: ch.transfer ? ch.transfer.amount - (ch.app_fee?.amount ?? 0) : null, os_net_actual: S_actual == null ? null : (ch.app_fee?.amount ?? 0) - S_actual });
  }
  printTable(run, 'E1 participation payments', [
    { h: 'C', f: (r) => gbp(r.C) }, { h: 'card', f: (r) => r.card }, { h: 'F model', f: (r) => gbp(r.F_model) }, { h: 'F measured', f: (r) => gbp(r.F_act) }, { h: 'commission', f: (r) => gbp(r.comm) }, { h: 'recovery est', f: (r) => gbp(r.rec) },
    { h: 'S assumed', f: (r) => gbp(r.S_model) }, { h: 'S actual', f: (r) => gbp(r.S_act) }, { h: 'S act-assumed', f: (r) => gbp(r.vs_model) }, { h: 'variance (est-actual)', f: (r) => gbp(r.variance) }, { h: 'organiser net model/actual', f: (r) => `${gbp(r.org_net)}/${gbp(r.org_net_actual)}` }, { h: 'OneShetland net (F-S)', f: (r) => gbp(r.os_net_actual) }, { h: 'fee_details', f: (r) => r.details }]);
});
