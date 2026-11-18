#!/usr/bin/env node
// Editions fee model DEMONSTRATION. Offline: no network, no database, no Stripe. Run: node scripts/editions-fee-demo.mjs
//
// It uses the REAL pure functions the payment code uses (feeParts, feePercent, stripePercentFee, commissionRefundDelta, recoveryVariance, refundParams, ...) and a deterministic MODEL of Stripe's
// money movements taken from Stripe's documentation for destination charges (full charge transferred to the connected account, application fee collected back, Stripe's fee paid by the platform,
// refunds from the platform with reverse_transfer, no return of Stripe's fee, dispute debits to the platform and recovery by transfer reversal).
//
// EVERYTHING BELOW THAT SAYS "ACTUAL" IS AN ASSUMPTION OF THIS MODEL, NOT A STRIPE FIGURE. The estimate rates (1.5% + 20p) are placeholders from the repo heuristic and are not Stripe's confirmed rates.
// Real behaviour can only be proven in Stripe test mode (the next stage).
import { feeParts, feePercent, stripePercentFee, commissionRefundDelta, commissionRefundedCumulative, recoveryVariance, refundParams, applicationFeeRefundRequest, transferReversalRequest } from '../supabase/functions/_shared/editions-commerce-core.ts';

const CFG = { commission_percent: 2, commission_fixed_pence: 0, commission_min_pence: 0, commission_cap_pence: null, stripe_cost_percent: 1.5, stripe_cost_fixed_pence: 20 };   // ESTIMATE rates: PLACEHOLDERS
const ASSUMED = { domestic: (c) => Math.round(c * 0.016) + 20, premium: (c) => Math.round(c * 0.025) + 20 };                                                                    // ASSUMED actual Stripe fee (a model, not Stripe's rates)
const DISPUTE_FEE = 1500;                                                                                                                                                         // ASSUMED dispute fee
const gbp = (p) => `${p < 0 ? '-' : p > 0 ? '+' : ' '}£${(Math.abs(p) / 100).toFixed(2).padStart(7)}`;
const pl = (p) => `£${(p / 100).toFixed(2)}`;

class World {
  constructor(title, note) { this.t = { customer: 0, organiser: 0, oneshetland: 0, stripe: 0 }; this.title = title; this.lines = []; console.log(`\n── ${title}${note ? `\n   ${note}` : ''}`); this.head(); }
  head() { console.log('   ' + 'event'.padEnd(58) + 'Customer  Organiser OneShetland  Stripe(fees)'); }
  move(what, d) { for (const k of Object.keys(d)) this.t[k] += d[k]; console.log('   ' + what.padEnd(58) + [d.customer ?? 0, d.organiser ?? 0, d.oneshetland ?? 0, d.stripe ?? 0].map((x) => gbp(x).padStart(10)).join(' ')); }
  total(label = 'running total') { console.log('   ' + label.padEnd(58) + [this.t.customer, this.t.organiser, this.t.oneshetland, this.t.stripe].map((x) => gbp(x).padStart(10)).join(' ')); }
  say(s) { console.log(`   > ${s}`); }
}

// the money movement of one destination charge: customer pays C; the whole C goes to the organiser; F comes back to the platform; the platform pays Stripe's fee S
function charge(w, label, C, F, S) { w.move(label, { customer: -C, organiser: C - F, oneshetland: F - S, stripe: S }); }

// a refund of R against a payment (C, commission, state): step 1 customer refund with reverse_transfer (platform keeps F), step 2 commission share back to the organiser
function refund(w, st, R, label) {
  const cum = st.refunded + R;
  w.say(`step 1: POST /v1/refunds ${JSON.stringify(refundParams({ payment_intent: 'pi_demo', amount_pence: R, request_id: '00000000-0000-4000-8000-000000000001' }))}`);
  w.move(`${label}: refund ${pl(R)} to the customer, transfer reversed`, { customer: R, organiser: -R, oneshetland: 0, stripe: 0 });
  const delta = commissionRefundDelta(st.commission, cum, st.C, st.commissionBack);
  if (delta > 0) {
    const q = applicationFeeRefundRequest({ application_fee_id: 'fee_demo', amount_pence: delta, request_id: '00000000-0000-4000-8000-000000000001' });
    w.say(`step 2: POST /v1${q.path} amount=${delta} (cumulative commission returned ${commissionRefundedCumulative(st.commission, cum, st.C)} of ${st.commission})`);
    w.move(`${label}: commission share ${pl(delta)} returned to the organiser`, { organiser: delta, oneshetland: -delta });
  } else w.say('step 2: nothing to return');
  st.refunded = cum; st.commissionBack += delta;
}

function payment(w, label, C, S, { interval } = {}) {
  const p = feeParts(C, CFG);
  w.say(`customer pays exactly ${pl(C)}. commission ${pl(p.commission)} (2%) + ESTIMATED processing fee ${pl(p.recovery)} (1.5% + 20p, placeholder) = application fee F ${pl(p.fee)}`);
  let F = p.fee;
  if (interval) {
    const pct = feePercent(p.fee, C); F = stripePercentFee(C, pct, 'nearest');
    w.say(`subscription: application_fee_percent=${pct} -> Stripe collects ${pl(F)} on this invoice (intended F ${pl(p.fee)}, error ${F - p.fee}p)`);
  }
  charge(w, label, C, F, S);
  const v = recoveryVariance(p.recovery, S);
  w.say(`Stripe's fee (ASSUMED actual) ${pl(S)}; variance = estimate ${pl(p.recovery)} - actual ${pl(S)} = ${v >= 0 ? '+' : '-'}${pl(Math.abs(v))}${Math.abs(v) > 20 ? '   >>> exceeds the 20p alert: a fee_variance exception is raised (no true-up)' : ''}`);
  return { C, commission: p.commission, recovery: p.recovery, F, S, refunded: 0, commissionBack: 0 };
}

console.log('EDITIONS FEE MODEL: DEMONSTRATION (offline MODEL of Stripe economics; estimate rates are PLACEHOLDERS; "actual" Stripe fees are ASSUMPTIONS)');
console.log('Columns are the CHANGE each party sees for that event. Customer: negative = pays. OneShetland = platform balance after Stripe\'s fee. Stripe(fees) = what Stripe keeps.');

for (const pounds of [10, 25, 100]) {
  const C = pounds * 100; const w = new World(`PARTICIPATION FEE £${pounds} (one-off PaymentIntent, destination charge)`);
  const st = payment(w, `payment of ${pl(C)}`, C, ASSUMED.domestic(C)); w.total();
  w.say(`organiser net = C - F = ${pl(C - st.F)}; OneShetland keeps commission ${pl(st.commission)} plus variance ${gbp(recoveryVariance(st.recovery, st.S)).trim()} = ${pl(st.commission + recoveryVariance(st.recovery, st.S))}`);
}

for (const pounds of [10, 25]) {
  const C = pounds * 100; const w = new World(`MEMBERSHIP £${pounds}/month (Stripe Subscription: invoices are destination charges; fee is a PERCENTAGE of the invoice)`);
  const first = payment(w, `first invoice ${pl(C)}`, C, ASSUMED.domestic(C), { interval: 'monthly' });
  payment(w, `renewal invoice ${pl(C)} (a month later)`, C, ASSUMED.domestic(C), { interval: 'monthly' }); w.total('running total (two invoices)');
  void first;
}

{
  const C = 2500; const w = new World('REFUNDS on a £25 participation payment: partial 40%, then a second partial, then the remainder (full refund overall)');
  const st = payment(w, 'payment of £25.00', C, ASSUMED.domestic(C));
  refund(w, st, 1000, 'partial refund 40% (£10.00)'); w.total('after 40% refund');
  refund(w, st, 750, 'second partial refund (£7.50)'); w.total('after second partial');
  refund(w, st, C - st.refunded, 'refund of the remainder (£7.50): now FULL'); w.total('after full refund');
  w.say(`full-refund result: customer +0 net (paid 25.00, refunded 25.00); organiser ${gbp(w.t.organiser).trim()} (bears the processing-cost estimate ${pl(st.recovery)}); OneShetland ${gbp(w.t.oneshetland).trim()} = estimate ${pl(st.recovery)} - Stripe fee ${pl(st.S)} (the variance)`);
  w.say('Stripe never returns its processing fee on a refund, so the organiser bears the unreturned estimate and OneShetland carries only the variance.');
}
{
  const C = 2500; const w = new World('FULL REFUND in one step (£25)');
  const st = payment(w, 'payment of £25.00', C, ASSUMED.domestic(C)); refund(w, st, C, 'full refund (£25.00)'); w.total('after full refund');
}

{
  const C = 2500; const w = new World('FAILED PAYMENT (£25 card declined)', 'No money moves, no application fee, no recovery row, no Stripe fee. A failed subscription invoice follows the existing grace / past_due behaviour.');
  w.move('card declined: PaymentIntent payment_failed', { customer: 0, organiser: 0, oneshetland: 0, stripe: 0 }); w.total(); void C;
}

{
  const C = 2500, D = 2500; const w = new World('LOST DISPUTE WITH RECOVERY (£25 payment; the connected account can cover the reversal)');
  const st = payment(w, 'payment of £25.00', C, ASSUMED.domestic(C));
  w.say('charge.dispute.created: recorded, payment flagged disputed, exception raised for the administrator.');
  w.move('Stripe debits the platform the disputed amount', { customer: D, oneshetland: -D });
  w.move('Stripe dispute fee (ASSUMED £15.00) debited from the platform', { oneshetland: -DISPUTE_FEE, stripe: DISPUTE_FEE });
  w.say('charge.dispute.closed status=lost: recovery queued; cron performs the transfer reversal.');
  const q = transferReversalRequest({ transfer_id: 'tr_demo', amount_pence: D, dispute_id: 'dp_demo' }); w.say(`POST /v1${q.path} ${JSON.stringify(q.params)}`);
  w.move('transfer reversal: the organiser returns the disputed amount', { organiser: -D, oneshetland: D }); w.total('after lost dispute + recovery');
  w.say(`OneShetland keeps commission ${pl(st.commission)} and the estimate (refund_commission_on_dispute = false: an assumption awaiting Darren) and bears Stripe's dispute fee ${pl(DISPUTE_FEE)}; the fee is recorded and reported, NOT passed to the organiser automatically.`);
}
{
  const C = 2500, D = 2500; const w = new World('LOST DISPUTE, INSUFFICIENT CONNECTED BALANCE (the organiser has already paid out the money)');
  payment(w, 'payment of £25.00', C, ASSUMED.domestic(C));
  w.move('Stripe debits the platform the disputed amount', { customer: D, oneshetland: -D });
  w.move('Stripe dispute fee (ASSUMED £15.00) debited from the platform', { oneshetland: -DISPUTE_FEE, stripe: DISPUTE_FEE });
  w.say('transfer reversal attempted: the model says Stripe refuses it (balance_insufficient). UNVERIFIED against real Stripe: the exact code is only provable in test mode.');
  w.move('transfer reversal FAILED (no money moves)', {});
  w.say('database: dispute_recovery_failed recorded with the Stripe error; an exception is raised for the administrator; the organiser\'s collection_suspended is set so no NEW payments are collected; the recovery stays pending for a manual retry; the worker does not loop.');
  w.total('platform is out of pocket until recovered'); w.say(`OneShetland exposure while blocked: ${pl(D + DISPUTE_FEE)}.`);
}

{
  const w = new World('VAT-REGISTERED ORGANISER: price £100.00 + 20% VAT (exclusive). The customer pays exactly the VAT-inclusive charge, as before; nothing is added by the fee model.');
  const price = 10000, vat = 2000, C = price + vat;
  w.say(`customer total (price + VAT) = ${pl(C)} in BOTH the old model and this one: unchanged for the customer.`);
  const st = payment(w, `payment of ${pl(C)} (price ${pl(price)} + VAT ${pl(vat)})`, C, ASSUMED.domestic(C));
  w.say(`the fee is computed on the VAT-inclusive charge as before; the organiser's VAT on its own sale is the organiser's affair; OneShetland charges NO VAT on the commission (not VAT registered): commission statement vat_pence = 0.`);
  w.total(); void st;
}
{
  const C = 10000; const w = new World('VARIANCE ALERT: £100 participation paid with an ASSUMED premium/international card (2.5% + 20p)');
  payment(w, 'payment of £100.00', C, ASSUMED.premium(C)); w.total();
  w.say('A large variance is surfaced to the administrator. There is no automatic true-up and no automatic refund of variance to organisers: the treatment of material variance is a pending commercial decision.');
}
console.log('\nEND OF MODEL. Nothing here touched Stripe, a database or any hosted service.');
