#!/usr/bin/env node
// E3 refunds on a 100.00 participation payment: partial, repeated partial, then the remainder. Each refund = product path (request -> cron) -> STEP 1 customer refund with reverse_transfer=true and
// refund_application_fee=false, STEP 2 commission-share application-fee refund. Verifies organiser and platform deltas against the contract model and that replays change nothing.
// usage: node e3-refunds.mjs [--dry-run] [--allow FILE] [--account acct_...]
import { simulate, init, setup, payParticipation, dbPay, cron, sync, hasType, q, asUser, readCharge, finish, addRow, printTable, commissionRefundedCumulative, gbp } from './lib/common.mjs';
import { applicationFeeRefundRequest } from '../../../supabase/functions/_shared/editions-commerce-core.ts';
const run = await init('E3-refunds', process.argv);
await finish(run, async () => {
  const S = await setup(run, { acct: run.accounts[0] }); const C = 10000;
  const P = await payParticipation(run, S, { C, card: 'uk', label: 'e3' }); const { commission, recovery, fee: F } = P.model; const S0 = P.ch.fee;
  run.check(`start: application fee ${F} = commission ${commission} + recovery ${recovery}`, P.ch.application_fee_amount === F, `measured ${P.ch.application_fee_amount}`);
  let cumR = 0;
  for (const [i, R] of [[1, 3000], [2, 2500], [3, 4500]]) {
    console.log(`\n-- refund ${i}: ${gbp(R)}`); cumR += R;
    const req = asUser(run, S.owner.id, `select public.edition_payment_request_refund('${P.paymentId}', ${R}, 'ZZ E3 refund ${i}')`);
    const cr = await cron(run, 'refunds'); run.check(`refund ${i}: cron submitted the customer refund and the commission step (HTTP ${cr.status})`, cr.status === 200 && cr.body.submitted === 1, JSON.stringify(cr.body));
    const cb = commissionRefundedCumulative(commission, cumR, C);
    const ch = await readCharge(run, P.chId); const refunds = (await run.api('GET', '/v1/refunds', { query: [['payment_intent', P.pi]] })).body.data ?? [];
    const last = refunds.find((r) => r.metadata?.request_id === req);
    run.check(`refund ${i}: Stripe refund ${R} carries our request id; the charge refunded total is ${cumR}`, !!last && last.amount === R && ch.refunded === cumR, `refunds ${JSON.stringify(refunds.map((r) => r.amount))} total ${ch.refunded}`);
    run.check(`refund ${i}: transfer reversed by ${cumR} cumulatively (reverse_transfer=true)`, ch.transfer?.reversed === cumR, `reversed ${ch.transfer?.reversed}`);
    run.check(`refund ${i}: application fee refunded = commission share ${cb} (round(commission x R/C)), and the recovery estimate is NOT returned`, ch.app_fee?.refunded === cb, `fee refunded ${ch.app_fee?.refunded}`);
    run.check(`refund ${i}: Stripe's own processing fee is NOT returned (platform fee ${S0} unchanged)`, ch.fee === S0, `fee ${ch.fee}`);
    const orgActual = ch.transfer ? ch.transfer.amount - ch.transfer.reversed - (ch.app_fee?.amount ?? 0) + (ch.app_fee?.refunded ?? 0) : null, orgModel = C - F - cumR + cb;
    const osActual = S0 == null ? null : (ch.app_fee?.amount ?? 0) - (ch.app_fee?.refunded ?? 0) - S0, osModel = S0 == null ? null : F - cb - S0;
    run.check(`refund ${i}: organiser net ${gbp(orgModel)} and OneShetland net ${gbp(osModel)} match the contract model`, orgActual === orgModel && osActual === osModel, `organiser ${orgActual}/${orgModel} platform ${osActual}/${osModel}`);
    await sync(run, hasType(['charge.refunded'])); await simulate(run, 'charge.refunded', { id: 'ch_sim_1', object: 'charge', payment_intent: P.pi, amount: C, amount_refunded: cumR, metadata: { kind: 'edition_participation' } });
    const d = dbPay(run, P.paymentId); run.check(`refund ${i}: ledger refunded ${cumR}, commission returned ${cb}`, d.refunded === cumR && d.commissionRefunded === cb, JSON.stringify(d));
    addRow(run, { i, R, cumR, cb, org_model: orgModel, org_act: orgActual, os_model: osModel, os_act: osActual, fee_ref: ch.app_fee?.refunded, rev: ch.transfer?.reversed });
    // replays
    const again = await cron(run, 'refunds'); run.check(`refund ${i}: replaying the cron submits nothing new`, again.body.submitted === 0 && again.body.commission_refunded === 0, JSON.stringify(again.body));
    const cdelta = i === 1 ? cb : cb - commissionRefundedCumulative(commission, cumR - R, C); if (cdelta > 0) {
      const q1 = applicationFeeRefundRequest({ application_fee_id: ch.app_fee?.id ?? 'fee_123', amount_pence: cdelta, request_id: req });
      const rep = await run.api('POST', q1.path.startsWith('/v1') ? q1.path : `/v1${q1.path}`, { data: Object.entries(q1.params), idempotencyKey: q1.idempotencyKey });
      const ch2 = await readCharge(run, P.chId); run.check(`refund ${i}: re-sending the SAME application-fee refund with the same idempotency key changes nothing`, rep.status >= 200 && rep.status < 300 && ch2.app_fee?.refunded === cb, `status ${rep.status} refunded ${ch2.app_fee?.refunded}`);
    }
  }
  const dd = dbPay(run, P.paymentId); run.check('after the remainder: customer refunded in full, all commission returned, organiser bears exactly the recovery estimate', dd.refunded === C && dd.commissionRefunded === commission, JSON.stringify(dd));
  let more = 'accepted'; try { asUser(run, S.owner.id, `select public.edition_payment_request_refund('${P.paymentId}', 100, 'ZZ over-refund')`); } catch (e) { more = e.message; }
  run.check('a refund of an already fully refunded payment is refused', /cannot be refunded|left|more than/i.test(more), more.slice(0, 100));
  printTable(run, 'E3 refunds on 100.00 (F = commission + recovery)', [{ h: 'step', f: (r) => r.i }, { h: 'refund', f: (r) => gbp(r.R) }, { h: 'cumulative', f: (r) => gbp(r.cumR) }, { h: 'commission back', f: (r) => gbp(r.cb) }, { h: 'fee refunded (Stripe)', f: (r) => gbp(r.fee_ref) }, { h: 'transfer reversed', f: (r) => gbp(r.rev) }, { h: 'organiser net model/measured', f: (r) => `${gbp(r.org_model)}/${gbp(r.org_act)}` }, { h: 'OneShetland net model/measured', f: (r) => `${gbp(r.os_model)}/${gbp(r.os_act)}` }]);
});
