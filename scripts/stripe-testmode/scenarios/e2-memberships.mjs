#!/usr/bin/env node
// E2 memberships: a Stripe Subscription (subscriptionParams) on a customer attached to a BILLING TEST CLOCK; first invoice plus two renewals by advancing the clock.
//   Prices 25.00, 250.00, 1,000.00 (and 203.62 / 303.23 with --extra). Reads each invoice's charge application_fee_amount and compares it with the expected fee F,
//   to learn how Stripe rounds application_fee_percent; reports the maximum error per amount and which rounding mode (floor / nearest / ceil) matches every invoice.
// The functions create the customer WITHOUT a clock, so the scenario pre-creates a clock customer and stores it with edition_customer_set: customerFor() then reuses it.
// usage: node e2-memberships.mjs [--dry-run] [--extra] [--renewals N] [--allow FILE] [--account acct_...]
import { journal, init, setup, checkout, sync, hasType, confirmPi, asUser, asService, q, finish, addRow, printTable, feeParts, feePercent, stripePercentFee, CFG, gbp, onCleanup } from './lib/common.mjs';
const run = await init('E2-memberships', process.argv);
const prices = [2500, 25000, 100000, ...(run.flag('--extra') ? [20362, 30323, 123456] : [])]; const renewals = Number(run.val('--renewals', '2'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await finish(run, async () => {
  const S = await setup(run, { acct: run.accounts[0], memberships: true });
  // Stripe allows at most 3 customers per test clock: open a new clock for every 3 customers (this was the cause of the 203.62 failure: the 4th customer create was refused)
  const clocks = []; const newClock = async () => { const c = run.must(await run.api('POST', '/v1/test_helpers/test_clocks', { data: [['frozen_time', String(Math.floor(Date.now() / 1000))], ['name', `oneshetland ${run.id} #${clocks.length + 1}`]] }), 'create test clock'); clocks.push(c); onCleanup(run, `test clock ${c.id} (deletes its customers and subscriptions)`, () => run.api('DELETE', `/v1/test_helpers/test_clocks/${c.id}`)); return c; };
  let clock = null, onClock = 0;
  const members = [];
  const { readFileSync, readdirSync } = await import('node:fs');
  const diagnose = async (price, co) => {   // whenever a checkout lacks subscription_id: full body, function log tail, forwarder's last requests (method, path, status only)
    console.log(`   DIAGNOSTIC for ${gbp(price)}: full checkout response: ${JSON.stringify(co)}`);
    try { const f = readdirSync(run.stack.dir).filter((n) => /\.log$/.test(n)); for (const n of f) console.log(`   --- ${n} (tail)\n${readFileSync(`${run.stack.dir}/${n}`, 'utf8').trim().split('\n').slice(-8).map((l) => '     ' + l.slice(0, 240)).join('\n')}`); } catch (e) { console.log(`   (no log: ${e.message})`); }
    try { const j = await journal(run); console.log(`   --- forwarder last requests:\n${j.slice(-10).map((x) => `     ${x.method} ${x.path} -> ${x.status}`).join('\n')}`); } catch { /* */ }
  };
  for (const price of prices) try {   // per-price isolation: one failure is reported and cannot poison the next price
    console.log(`\n-- membership at ${gbp(price)} per month`);
    if (!clock || onClock >= 3) { clock = await newClock(); onClock = 0; } onClock++;
    const payer = await S.newPayer(`m${price}`);
    const cus = run.must(await run.api('POST', '/v1/customers', { data: [['email', payer.email], ['test_clock', clock.id], ['metadata[kind]', 'edition_customer'], ['metadata[user_id]', payer.id], ['metadata[oneshetland_test_run]', run.id]] }), 'create clock customer');
    const pm = run.must(await run.api('POST', '/v1/payment_methods/pm_card_gb/attach', { data: [['customer', cus.id]] }), 'attach card');
    run.must(await run.api('POST', `/v1/customers/${cus.id}`, { data: [['invoice_settings[default_payment_method]', pm.id]] }), 'default payment method');
    if (!String(cus.id).startsWith('cus_')) throw new Error(`customer create returned no id: ${JSON.stringify(cus).slice(0, 200)}`);
    asService(run, `select public.edition_customer_set('${payer.id}','${cus.id}')`);
    const tier = asUser(run, S.owner.id, `select public.edition_tier_save('${S.org}', null, 'ZZ ${run.id.slice(-4)} ${price}', 'd', '[]'::jsonb, ${price}, null, false, 'none', 'open', 'none', null, null, 1)`);
    const mem = asUser(run, payer.id, `select public.edition_membership_apply('${tier}', '${payer.biz}', 'monthly')`);
    const co = await checkout(run, payer, { kind: 'membership', id: mem, attempt: `attempt-${run.id.slice(-6)}-m${price}` });
    run.check(`checkout accepted (HTTP 200) with a subscription`, co.status === 200 && co.body.subscription_id, `${co.status} ${JSON.stringify(co.body).slice(0, 140)}`);
    if (!co.body.subscription_id) { await diagnose(price, co); throw new Error(`no subscription_id for ${price}`); }
    const sub = co.body.subscription_id; onCleanup(run, `subscription ${sub}`, () => run.api('DELETE', `/v1/subscriptions/${sub}`));
    const F = feeParts(price, CFG).fee, pct = feePercent(F, price);
    const so = (await run.api('GET', `/v1/subscriptions/${sub}`)).body; run.check(`subscription application_fee_percent is ${pct} (F ${F}p of ${price}p)`, Number(so.application_fee_percent) === pct, `stripe says ${so.application_fee_percent}`);
    const piId = String(co.body.client_secret ?? '').split('_secret_')[0]; if (piId.startsWith('pi_')) await confirmPi(run, piId, pm.id);
    members.push({ price, sub, mem, F, pct, payer, cus: cus.id, clock: clock.id });
  } catch (e) { run.check(`membership at ${gbp(price)} completed its setup`, false, e.message.slice(0, 200)); }
  await sync(run, hasType(['invoice.paid']));
  run.warn('FINDING: events are in API version 2023-10-16 (account default arrives instead; known Stripe-side fact)', run.dry || (run.eventVersions ?? []).every((v) => v === '2023-10-16'), (run.eventVersions ?? []).join(','));
  for (let i = 1; i <= renewals; i++) {
    console.log(`\n-- advancing ${clocks.length} test clock(s) to +${i * 31} days`);
    for (const ck of clocks) {
      const cur = run.must(await run.api('GET', `/v1/test_helpers/test_clocks/${ck.id}`), 'read clock'); const to = cur.frozen_time + 31 * 86400;
      run.must(await run.api('POST', `/v1/test_helpers/test_clocks/${ck.id}/advance`, { data: [['frozen_time', String(to)]] }), 'advance clock');
    }
    for (const ck of clocks) for (let k = 0; k < 60 && !run.dry; k++) { const c = run.must(await run.api('GET', `/v1/test_helpers/test_clocks/${ck.id}`), 'poll clock'); if (c.status === 'ready') break; await sleep(2000); }
    await sleep(run.dry ? 0 : 4000); await sync(run, (evs) => evs.filter((e) => e.type === 'invoice.paid').length >= members.length * (i + 1));
  }
  for (const m of members) {
    // version-agnostic: invoices lost `charge` in API 2025-08-27.basil, so read the customer's charges (one customer per payer)
    const chs = ((await run.api('GET', '/v1/charges', { query: [['customer', m.cus], ['limit', '20']] })).body.data ?? []).filter((c) => c.status === 'succeeded');
    const rows = chs.map((c) => ({ invoice: c.id, amount: c.amount, fee: c.application_fee_amount }));
    const errs = rows.map((r) => (r.fee ?? 0) - m.F); const maxErr = errs.length ? Math.max(...errs.map(Math.abs)) : null;
    const modes = ['floor', 'nearest', 'ceil'].filter((mo) => rows.every((r) => stripePercentFee(m.price, m.pct, mo) === r.fee));
    run.check(`${gbp(m.price)}: ${rows.length} succeeded charges (expected ${renewals + 1}), each amount ${m.price}`, rows.length === renewals + 1 && rows.every((r) => r.amount === m.price), JSON.stringify(rows.map((r) => r.amount)));
    run.check(`${gbp(m.price)}: max |application fee - F| is within the scaled tolerance (1p + ceil(charge x 0.00005) = ${1 + Math.ceil(m.price / 20000)}p)`, maxErr !== null && maxErr <= 1 + Math.ceil(m.price / 20000), `max error ${maxErr}p`);
    const led = q(run, `select count(*) from edition_payments where kind='membership' and ref_id='${m.mem}'`);
    run.check(`${gbp(m.price)}: the ledger recorded ${renewals + 1} membership payments${Number(led) === renewals + 1 ? '' : '  [EVENT-SHAPE cause likely: webhook must tolerate API ' + (run.eventVersions ?? []).join(',') + ' (no invoice.charge/payment_intent); not a harness fault]'}`, Number(led) === renewals + 1, `ledger ${led}`);
    addRow(run, { price: m.price, F: m.F, pct: m.pct, fees: rows.map((r) => r.fee).join(','), maxErr, modes: rows.length ? (modes.join('/') || 'none matched') : 'no invoices' });
  }
  printTable(run, 'E2 memberships: how Stripe rounds application_fee_percent', [{ h: 'price', f: (r) => gbp(r.price) }, { h: 'F model', f: (r) => gbp(r.F) }, { h: 'percent sent', f: (r) => r.pct }, { h: 'fees collected (p)', f: (r) => r.fees }, { h: 'max error (p)', f: (r) => r.maxErr }, { h: 'consistent with', f: (r) => r.modes }]);
});
