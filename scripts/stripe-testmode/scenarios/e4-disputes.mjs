#!/usr/bin/env node
// E4 disputes. (a) LOSS PATH: charge with test card 4000000000000259 (pm_card_createDispute), close the dispute LOST with evidence text `losing_evidence`, verify the dispute events reach the DB,
// the transfer reversal recovers the disputed amount from the organiser, the platform keeps the application fee. (b) INSUFFICIENT BALANCE: drain the chosen connected account's available balance with
// a TEST payout (this account is changed: a payout is recorded and cannot be undone; it is named in the output), run the recovery on a second lost dispute and capture Stripe's exact behaviour,
// the DB failure path, collection_suspended and the alert (reconciliation exception + audit).
// usage: node e4-disputes.mjs [--dry-run] [--skip-drain] [--allow FILE] [--account acct_...]
import { deliver, fetchEvents, simulate, init, setup, payParticipation, dbPay, cron, sync, hasType, q, asUser, readCharge, finish, addRow, printTable, journal, gbp } from './lib/common.mjs';
const run = await init('E4-disputes', process.argv);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dstate = (run, id) => q(run, `select status || '|' || blocked || '|' || attempts || '|' || recovery_pence || '|' || coalesce(stripe_reversal_id,'-') || '|' || coalesce(last_error,'-') from edition_dispute_recoveries where dispute_id='${id}'`);
async function lostDispute(S, label) {
  const P = await payParticipation(run, S, { C: 10000, card: 'dispute', label });
  let dp = null; for (let i = 0; i < 20 && !dp && !run.dry; i++) { dp = ((await run.api('GET', '/v1/disputes', { query: [['charge', P.chId]] })).body.data ?? [])[0]; if (!dp) await sleep(3000); }
  if (run.dry) dp = { id: 'dp_123', amount: 10000, status: 'needs_response' };
  run.check(`${label}: Stripe opened a dispute for the full ${gbp(10000)}`, dp && dp.amount === 10000, dp ? `${dp.id} ${dp.status}` : 'none');
  { const t0 = Date.now(); let got = run.dry; while (!got && Date.now() - t0 < 60000) { const evs = await fetchEvents(run); got = evs.some((e) => e.type === 'charge.dispute.created' && JSON.stringify(e.data?.object).includes(dp.id)); if (got) await sync(run); else await sleep(3000); } run.check(`${label}: charge.dispute.created for ${dp.id} fetched and delivered`, got); }
  await simulate(run, 'charge.dispute.created', { id: dp.id, object: 'dispute', payment_intent: P.pi, amount: 10000, status: 'needs_response', reason: 'general', balance_transactions: [{ fee: 1500 }] });
  { const evs = await fetchEvents(run); const ev = evs.find((e) => e.type === 'charge.dispute.created' && JSON.stringify(e.data?.object).includes(dp.id));
    if (ev && !(run.deliveries?.[ev.id]?.length)) { await deliver(run, ev); run.delivered.add(ev.id); console.log(`   NOTE: ${ev.id} had not been delivered yet; delivered it once now`); }
    const dl = ev ? run.deliveries?.[ev.id] : null; const d = dbPay(run, P.paymentId); const rec = q(run, `select coalesce(string_agg(status || ' ' || recovery_pence, ';'), 'none') from edition_dispute_recoveries where dispute_id='${dp.id}'`);
    console.log(`   dispute.created delivery (event ${ev?.id}, ${dl?.length ?? 0} delivery/ies): ${JSON.stringify(dl)}; ledger dispute_state=${d.dispute} status=${d.status}; recoveries row: ${rec}`);
    run.check(`${label}: DB recorded the dispute (state, not yet recovered); see delivery/ledger/recovery evidence above`, run.dry || (dl?.some((x) => x.status === 200 && !x.body.ignored) && d.dispute !== '-' && d.recovered === 0), `state ${d.dispute} status ${d.status} recoveries ${rec}`); }
  run.must(await run.api('POST', `/v1/disputes/${dp.id}`, { data: [['evidence[uncategorized_text]', 'losing_evidence'], ['submit', 'true'], ['metadata[oneshetland_test_run]', run.id]] }), 'submit losing evidence');
  let closed = dp; for (let i = 0; i < 30 && !run.dry; i++) { closed = (await run.api('GET', `/v1/disputes/${dp.id}`)).body; if (closed.status === 'lost') break; await sleep(3000); }
  run.check(`${label}: the dispute closed LOST`, closed.status === 'lost' || run.dry, closed.status);
  await sync(run, hasType(['charge.dispute.closed'])); await simulate(run, 'charge.dispute.closed', { id: dp.id, object: 'dispute', payment_intent: P.pi, amount: 10000, status: 'lost', reason: 'general', balance_transactions: [{ fee: 1500 }] });
  return { P, dp, closed };
}
await finish(run, async () => {
  const S = await setup(run, { acct: run.accounts[0] });
  { const acc = (await run.api('GET', `/v1/accounts/${S.acct}`)).body; const bal0 = (await run.api('GET', '/v1/balance', { account: S.acct })).body; const g = (a) => (bal0[a] ?? []).map((x) => `${x.currency}:${x.amount}`).join(',') || '-';
    console.log(`   ACCOUNT ${S.acct}: debit_negative_balances=${acc.settings?.payouts?.debit_negative_balances}; balance before: available ${g('available')} pending ${g('pending')}`); }
  console.log('\n== (a) loss path');
  const A = await lostDispute(S, 'a');
  const st = dstate(run, A.dp.id).split('|'); run.check('(a) recovery queued: pending for the disputed amount 10000', st[0] === 'pending' && Number(st[3]) === 10000, st.join('|'));
  const cr = await cron(run, 'disputes'); run.check(`(a) cron disputes: one recovery`, cr.status === 200 && cr.body.recovered === 1, JSON.stringify(cr.body));
  const ch = await readCharge(run, A.P.chId);
  const revs = (await run.api('GET', `/v1/transfers/${ch.transfer?.id ?? 'tr_123'}/reversals`, { query: [['limit', '100']] })).body.data ?? [];
  run.check('(a) ONE transfer reversal of 10000, tagged with the dispute id, and no application-fee refund', revs.length === 1 && revs[0].amount === 10000 && revs[0].metadata?.dispute_id === A.dp.id && !(ch.app_fee?.refunded > 0), JSON.stringify(revs.map((r) => [r.amount, r.metadata?.dispute_id])));
  const st2 = dstate(run, A.dp.id).split('|'); run.check('(a) DB recovery is done with the reversal id; ledger shows 10000 lost and recovered', st2[0] === 'done' && dbPay(run, A.P.paymentId).recovered === 10000, `${st2.join('|')} ${JSON.stringify(dbPay(run, A.P.paymentId))}`);
  const again = await cron(run, 'disputes'); run.check('(a) replaying the recovery does nothing', again.body.recovered === 0, JSON.stringify(again.body));
  const fee = (A.closed.balance_transactions ?? []).reduce((a, b) => a + (b.fee ?? 0), 0);
  addRow(run, { case: 'a loss, recovered', D: 10000, F: A.P.model.fee, S: ch.fee, disputeFee: fee, reversal: revs[0]?.amount, org_net: ch.transfer ? ch.transfer.amount - ch.transfer.reversed - (ch.app_fee?.amount ?? 0) : null, os_net: ch.fee == null ? null : (ch.app_fee?.amount ?? 0) - ch.fee - fee, note: 'platform keeps F; dispute fee stays with the platform' });

  console.log('\n== (b) insufficient connected balance');
  let drained = 'skipped';
  if (!run.flag('--skip-drain')) {
    const bal = (await run.api('GET', '/v1/balance', { account: S.acct })).body; const avail = (bal.available ?? []).find((x) => x.currency === 'gbp')?.amount ?? 0;
    console.log(`   NOTE: this CHANGES the connected test account ${S.acct}: its available balance (${avail}p) is paid out by a TEST payout.`);
    if (avail > 0) { const po = await run.api('POST', '/v1/payouts', { account: S.acct, data: [['amount', String(avail)], ['currency', 'gbp'], ['metadata[oneshetland_test_run]', run.id]] }); drained = po.ok ? `payout ${po.body.id} of ${avail}p` : `payout refused: ${po.body?.error?.message}`; } else drained = 'available balance already 0';
    console.log(`   drain: ${drained}`);
  }
  const B = await lostDispute(S, 'b'); const q0 = dstate(run, B.dp.id).split('|');
  const cr2 = await cron(run, 'disputes'); const j = await journal(run); const lastRev = [...j].reverse().find((x) => /\/transfers\/[^/]+\/reversals$/.test(x.path) && x.method === 'POST');
  const sb = dstate(run, B.dp.id).split('|'); const susp = q(run, `select collection_suspended || '|' || coalesce(suspended_reason,'-') from edition_payout_accounts where organiser_id='${S.org}'`); const exc = q(run, `select count(*) from edition_reconciliation_exceptions where kind='dispute_recovery_failed' and provider_ref='${B.dp.id}'`);
  const aud = q(run, `select count(*) from edition_audit_log where organiser_id='${S.org}' and action in ('collection_suspended','dispute_recovery_blocked')`);
  console.log(`   CAPTURED  Stripe reversal HTTP status ${lastRev?.status}; cron result ${JSON.stringify(cr2.body)}; DB state ${sb.join('|')}; suspended ${susp}; exceptions ${exc}; audit rows ${aud}`);
  if (lastRev && lastRev.status >= 400) {
    run.check('(b) Stripe REFUSED the reversal; DB marked it blocked (insufficient) or failed, kept pending/failed, did not loop', ['pending', 'failed'].includes(sb[0]) && Number(sb[2]) === 1, sb.join('|'));
    run.check('(b) collection_suspended is true and the alert exists (reconciliation exception dispute_recovery_failed)', susp.startsWith('true') && Number(exc) >= 1, `${susp} exceptions ${exc}`);
    run.check('(b) a second recovery run does not hammer Stripe (blocked rows are not retried automatically)', (await cron(run, 'disputes')).body.recovered === 0);
  } else {
    run.check('(b) ALLOWED outcome: Stripe permitted the reversal (negative connected balance = platform exposure, or pending funds covered it): DB done, no suspension', sb[0] === 'done' && susp.startsWith('false'), `${sb.join('|')} ${susp}`);
    console.log('   FINDING: the reversal was allowed; the shortage failure path was not exercised. Check the balance line above for negative balance (platform exposure).');
  }
  const balB = (await run.api('GET', '/v1/balance', { account: S.acct })).body; const gB = (a) => (balB[a] ?? []).map((x) => `${x.currency}:${x.amount}`).join(',') || '-';
  console.log(`   CAPTURED Stripe error/behaviour: ${sb[5] && sb[5] !== '-' ? sb[5] : 'no error: the reversal was allowed'}; connected balance afterwards: available ${gB('available')} pending ${gB('pending')} ${[...(balB.available ?? []), ...(balB.pending ?? [])].some((x) => x.amount < 0) ? '(NEGATIVE: platform exposure)' : ''}`);
  addRow(run, { case: 'b drained account', D: 10000, F: B.P.model.fee, S: null, disputeFee: null, reversal: lastRev?.status, org_net: null, os_net: null, note: `drain ${drained}; Stripe status ${lastRev?.status}` });
  printTable(run, 'E4 disputes', [{ h: 'case', f: (r) => r.case }, { h: 'disputed', f: (r) => gbp(r.D) }, { h: 'F', f: (r) => gbp(r.F) }, { h: 'Stripe fee S', f: (r) => gbp(r.S) }, { h: 'dispute fee', f: (r) => gbp(r.disputeFee) }, { h: 'reversal (amount or HTTP status)', f: (r) => (r.reversal > 999 ? gbp(r.reversal) : r.reversal) }, { h: 'organiser net', f: (r) => gbp(r.org_net) }, { h: 'OneShetland net', f: (r) => gbp(r.os_net) }, { h: 'note', f: (r) => r.note }]);
});
