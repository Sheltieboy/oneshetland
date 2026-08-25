/**
 * wallet-recovery.node.test.ts — money that comes back out of a card comes
 * back out of the wallet.
 *
 * THE HOLE
 *
 * A card top-up credited spendable stored value and nothing ever looked at that
 * charge again. charge.refunded touched delivery requests and event tickets and
 * never the wallet; charge.dispute.created was not a handled event at all. So a
 * customer could top up £100, spend it at a business — real money transferred to
 * that business's connected account — then refund or charge back the card, and
 * the wallet would be untouched. The platform absorbed it, silently.
 *
 * THE MODEL
 *
 * One column (deficit_pence), one table (local_wallet_topup_recovery), three
 * functions. Recovery works on Stripe's CUMULATIVE figures rather than per-event
 * deltas, because charge.refunded carries amount_refunded — a running total —
 * and Stripe delivers events more than once. Each row recovers only
 *
 *     greatest(refunded, dispute_lost) − already recovered
 *
 * which is monotonic, capped at the original top-up, and cannot take the same
 * £100 twice however many events describe it.
 *
 * Available balance is taken first. Any shortfall becomes a deficit: not a
 * negative balance, because the ledger records money that MOVED and a deficit is
 * money that did not. Spending is refused while it stands — by the debit
 * primitive itself, not by a hidden button — and the next top-up repays it
 * before anything becomes spendable.
 *
 * TWO SMALLER FIXES IN THE SAME PLACE
 *
 * The Stripe key fell back to `topup-<user>-<amount>` and neither client ever
 * sent an override, so that fallback WAS the key: topping up £10 twice in a day
 * returned the first PaymentIntent and told the customer their money had
 * arrived. And the amount guard leaned on JavaScript coercion — the string
 * "1000" created a real £10 PaymentIntent.
 *
 * SAFETY
 * Every database assertion runs in a transaction that is never committed, using
 * synthetic payment references. No top-up is made, no real balance is touched,
 * and no Stripe object is created.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const web = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');

const intentFn = read('supabase/functions/local-wallet-topup-intent/index.ts');
const confirmFn = read('supabase/functions/local-wallet-confirm-topup/index.ts');
const webhook = read('supabase/functions/stripe-webhook/index.ts');
const ledgerHelper = read('supabase/functions/_shared/wallet-ledger.ts');
const fulfilment = read('supabase/functions/_shared/fulfilment.ts');
const recoveryMig = read('supabase/migrations/20260826140000_wallet_refund_and_dispute_recovery.sql');
const blockMig = read('supabase/migrations/20260826150000_wallet_spend_blocked_by_recovery.sql');
const webClient = web('lib/local-commerce-client.ts');
const webModal = web('components/local/WalletTopUpModal.tsx');
const webWallet = web('app/account/wallet/WalletClient.tsx');
const appApi = read('lib/local-api.ts');
const appWallet = read('app/local-wallet.tsx');

const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

function rowsOf(out: string): Record<string, unknown>[] {
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
}
const runSql = (sql: string) => rowsOf(execFileSync('npx',
  ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }));

const SCENARIO = `
begin;
create temp table r(step text, outcome text);
do $$
declare u uuid; x record; d record; b record;
begin
  select id into u from auth.users order by created_at limit 1;

  -- ── refund while the money is still there ──────────────────────────────
  perform public.wallet_topup(u, 10000, 'pi_wr_full');
  select * into x from public.wallet_recover_topup('pi_wr_full', 'refund', 10000);
  insert into r values ('full_taken',   x.taken_pence::text);
  insert into r values ('full_deficit', x.deficit_pence::text);
  select * into x from public.wallet_recover_topup('pi_wr_full', 'refund', 10000);
  insert into r values ('full_retry', case when x.already then 'no_change' else 'TOOK AGAIN' end);

  -- ── partial, then a larger cumulative figure ───────────────────────────
  perform public.wallet_topup(u, 10000, 'pi_wr_part');
  select * into x from public.wallet_recover_topup('pi_wr_part', 'refund', 2000);
  insert into r values ('part_first', x.taken_pence::text);
  select * into x from public.wallet_recover_topup('pi_wr_part', 'refund', 5000);
  insert into r values ('part_delta_only', x.recovered_now_pence::text);
  select * into x from public.wallet_recover_topup('pi_wr_part', 'refund', 5000);
  insert into r values ('part_repeat', case when x.already then 'no_change' else 'TOOK AGAIN' end);

  -- ── refund after the money has been spent, through the REAL debit ──────
  perform public.wallet_topup(u, 10000, 'pi_wr_spent');
  select * into b from public.wallet_debit_with_ledger(u, 13000, 0, 'spend', null, 'PROBE spend', 'wr-spend-1');
  insert into r values ('spend_allowed', case when b.blocked then 'BLOCKED' when b.insufficient then 'insufficient' else 'spent' end);
  insert into r select 'balance_now', balance_pence::text from public.local_wallet_balances where user_id = u;

  select * into x from public.wallet_recover_topup('pi_wr_spent', 'refund', 10000);
  insert into r values ('spent_taken',   x.taken_pence::text);
  insert into r values ('spent_deficit', x.deficit_pence::text);
  insert into r values ('spent_reason',  x.reason);
  insert into r select 'reconciles_after_recovery', delta_pence::text from public.wallet_reconciliation() where user_id = u;

  -- ── spending is refused while a deficit stands ─────────────────────────
  select * into b from public.wallet_debit_with_ledger(u, 1, 0, 'spend', null, 'PROBE spend', 'wr-spend-2');
  insert into r values ('spend_with_deficit', case when b.blocked then 'blocked:' || b.block_reason else 'ALLOWED' end);
  insert into r select 'blocked_claims_nothing',
    case when exists (select 1 from public.local_wallet_transactions where idempotency_key = 'wr-spend-2')
         then 'CLAIMED' else 'nothing claimed' end;

  -- ── the next top-up repays it first ───────────────────────────────────
  select * into d from public.wallet_topup(u, 10000, 'pi_wr_repay');
  insert into r values ('repaid',      d.deficit_repaid_pence::text);
  insert into r values ('spendable',   d.balance_pence::text);
  insert into r select 'deficit_left', deficit_pence::text from public.local_wallet_balances where user_id = u;
  insert into r select 'reconciles_after_repay', delta_pence::text from public.wallet_reconciliation() where user_id = u;
  select * into b from public.wallet_debit_with_ledger(u, 100, 0, 'spend', null, 'PROBE spend', 'wr-spend-3');
  insert into r values ('spend_after_repay', case when b.blocked then 'BLOCKED' when b.insufficient then 'insufficient' else 'allowed' end);

  -- ── disputes ──────────────────────────────────────────────────────────
  perform public.wallet_topup(u, 5000, 'pi_wr_dis');
  select * into x from public.wallet_set_dispute_state('pi_wr_dis', 'dp_wr', 'open');
  insert into r values ('dispute_open', case when x.blocked then 'blocked:' || x.reason else 'ALLOWED' end);
  select * into b from public.wallet_debit_with_ledger(u, 100, 0, 'spend', null, 'PROBE spend', 'wr-spend-4');
  insert into r values ('spend_during_dispute', case when b.blocked then 'blocked:' || b.block_reason else 'ALLOWED' end);
  select * into x from public.wallet_set_dispute_state('pi_wr_dis', 'dp_wr', 'open');
  insert into r values ('dispute_open_repeat', coalesce(x.state, 'null'));
  insert into r select 'dispute_no_debt_yet', deficit_pence::text from public.local_wallet_balances where user_id = u;

  select * into x from public.wallet_set_dispute_state('pi_wr_dis', 'dp_wr', 'won');
  insert into r values ('dispute_won', case when x.blocked then 'STILL BLOCKED' else 'unblocked' end);
  select * into x from public.wallet_set_dispute_state('pi_wr_dis', 'dp_wr', 'open');
  insert into r values ('won_not_reopened', coalesce(x.state, 'null'));

  -- ── dispute lost, and then Stripe describing the same money again ─────
  perform public.wallet_topup(u, 5000, 'pi_wr_lost');
  select * into x from public.wallet_recover_topup('pi_wr_lost', 'dispute_lost', 5000, 'dp_wr2');
  insert into r values ('lost_taken', x.taken_pence::text);
  select * into x from public.wallet_recover_topup('pi_wr_lost', 'dispute_lost', 5000, 'dp_wr2');
  insert into r values ('lost_repeat', case when x.already then 'no_change' else 'TOOK AGAIN' end);
  select * into x from public.wallet_recover_topup('pi_wr_lost', 'refund', 5000);
  insert into r values ('refund_after_lost', case when x.already then 'no_double_recovery' else 'DOUBLE RECOVERED' end);
  insert into r select 'lost_total', recovered_pence::text from public.local_wallet_topup_recovery where payment_intent_id = 'pi_wr_lost';

  -- ── never more than was credited ──────────────────────────────────────
  perform public.wallet_recover_topup('pi_wr_lost', 'refund', 999999);
  insert into r select 'cap', recovered_pence::text from public.local_wallet_topup_recovery where payment_intent_id = 'pi_wr_lost';

  -- ── a charge that was never a top-up ──────────────────────────────────
  select * into x from public.wallet_recover_topup('pi_never_a_topup', 'refund', 5000);
  insert into r values ('not_a_topup', x.reason);
  select * into x from public.wallet_set_dispute_state('pi_never_a_topup', 'dp_x', 'open');
  insert into r values ('dispute_not_a_topup', x.reason);

  -- ── the existing core, unchanged ──────────────────────────────────────
  select * into d from public.wallet_topup(u, 2500, 'pi_wr_once');
  insert into r values ('topup_first', case when d.already_credited then 'ALREADY' else 'credited' end);
  select * into d from public.wallet_topup(u, 2500, 'pi_wr_once');
  insert into r values ('topup_replay', case when d.already_credited then 'already' else 'CREDITED TWICE' end);
  insert into r select 'one_ledger_row', count(*)::text from public.local_wallet_transactions
    where stripe_payment_intent_id = 'pi_wr_once';
  insert into r select 'final_reconciles', delta_pence::text from public.wallet_reconciliation() where user_id = u;

  -- ── grants ────────────────────────────────────────────────────────────
  insert into r select 'client_exec',
    case when has_function_privilege('anon','public.wallet_recover_topup(text,text,integer,text)','execute')
           or has_function_privilege('authenticated','public.wallet_recover_topup(text,text,integer,text)','execute')
           or has_function_privilege('anon','public.wallet_set_dispute_state(text,text,text)','execute')
           or has_function_privilege('authenticated','public.wallet_set_dispute_state(text,text,text)','execute')
           or has_function_privilege('anon','public.wallet_topup(uuid,integer,text)','execute')
           or has_function_privilege('authenticated','public.wallet_topup(uuid,integer,text)','execute')
         then 'CALLABLE' else 'none' end;
  insert into r select 'recovery_table_client_read',
    case when has_table_privilege('anon','public.local_wallet_topup_recovery','select')
           or has_table_privilege('authenticated','public.local_wallet_topup_recovery','select')
         then 'READABLE' else 'none' end;
  insert into r select 'balance_never_negative',
    case when exists (select 1 from public.local_wallet_balances where balance_pence < 0) then 'NEGATIVE' else 'none' end;
end $$;
select step, outcome from r;
`;

let cached: Record<string, string> | null = null;
function scenario(): Record<string, string> {
  if (!cached) cached = Object.fromEntries(runSql(SCENARIO).map((r) => [String(r.step), String(r.outcome)]));
  return cached;
}

/* ── A. attempt identity ──────────────────────────────────────────────────── */

describe('A — one deliberate top-up, one PaymentIntent', () => {
  test('client_request_id is required and validated before Stripe', () => {
    assert.match(intentFn, /typeof client_request_id !== 'string'/);
    assert.match(intentFn, /client_request_id\.length < 8 \|\| client_request_id\.length > 100/);
    assert.ok(intentFn.indexOf('client_request_id required') < intentFn.indexOf("fetch('https://api.stripe.com/v1/payment_intents'"));
  });

  test('the stale user+amount fallback is gone', () => {
    assert.match(intentFn, /const topupIdemKey = `topup-\$\{user\.id\}-\$\{client_request_id\}`/);
    assert.ok(!/`topup-\$\{user\.id\}-\$\{amount_pence\}`/.test(intentFn), 'the stale fallback key is still there');
  });

  test('the card-form route has a key now too', () => {
    assert.match(intentFn, /'Idempotency-Key': `topup-form-\$\{user\.id\}-\$\{client_request_id\}`/);
  });

  test('both clients mint one per deliberate top-up', () => {
    // The reset key gained a session after the first real top-up showed that
    // the amount alone is not enough: closing and topping up £5 again is a
    // SECOND deliberate top-up and must not reuse the first reference.
    assert.match(webModal, /const attemptId = useAttemptId\(`\$\{session\}\|\$\{amount\}\|\$\{customAmount\}`\)/);
    assert.match(webModal, /startWalletTopUp\(amount, attemptId\(\), true\)/);
    assert.match(appWallet, /const topUpAttempt = useAttemptId\(`\$\{topUpSession\}\|\$\{attemptAmount\}`\)/);
    assert.match(appWallet, /startWalletTopUp\(amountPence, topUpAttempt\(\), true\)/);
  });

  test('the app records the amount on BOTH entry paths, so neither shares an attempt', () => {
    const fn = appWallet.slice(appWallet.indexOf('const requestTopUp'), appWallet.indexOf('const requestTopUp') + 260);
    assert.match(fn, /setAttemptAmount\(amountPence\)/);
    assert.ok(fn.indexOf('setAttemptAmount') < fn.indexOf('has_payment_method'));
  });

  test('both clients send it', () => {
    assert.match(webClient, /client_request_id: attemptId/);
    assert.match(appApi, /client_request_id: attemptId/);
  });
});

/* ── B. amount validation ─────────────────────────────────────────────────── */

describe('B — the amount is a genuine integer number of pence', () => {
  test('type, finiteness, integrality and bounds are all checked', () => {
    assert.match(intentFn, /typeof amount_pence !== 'number'/);
    assert.match(intentFn, /!Number\.isFinite\(amount_pence\)/);
    assert.match(intentFn, /!Number\.isInteger\(amount_pence\)/);
    assert.match(intentFn, /amount_pence < 500 \|\| amount_pence > 50_000/);
  });

  test('the coercion-based guard is gone', () => {
    // Comments stripped: the replacement explains what it replaced.
    assert.ok(!/!amount_pence \|\| amount_pence < 500/.test(code(intentFn)));
  });

  test('currency stays server-side', () => {
    assert.match(intentFn, /currency: 'gbp'/);
    assert.ok(!code(intentFn).includes('body.currency'));
  });

  test('and the CREDIT still comes from Stripe, never the request', () => {
    assert.match(confirmFn, /const amount = intent\.amount/);
    assert.match(confirmFn, /Amount comes from Stripe \(server-verified\), never the client/);
  });
});

/* ── C. refund recovery ───────────────────────────────────────────────────── */

describe('C — a refunded top-up comes back out of the wallet', () => {
  const s = () => scenario();

  test('a full refund with the funds still there takes all of it', () => {
    assert.equal(s().full_taken, '10000');
    assert.equal(s().full_deficit, '0');
  });

  test('the same event again takes nothing more', () => {
    assert.equal(s().full_retry, 'no_change');
  });

  test('a partial refund takes only that part', () => {
    assert.equal(s().part_first, '2000');
  });

  test('and a larger cumulative figure takes only the difference', () => {
    assert.equal(s().part_delta_only, '3000');
    assert.equal(s().part_repeat, 'no_change');
  });

  test('a refund after the money is spent takes what is there', () => {
    assert.equal(s().spend_allowed, 'spent');
    assert.equal(s().spent_taken, '2000');
  });

  test('and records the rest as a deficit rather than failing silently', () => {
    assert.equal(s().spent_deficit, '8000');
    assert.equal(s().spent_reason, 'partial_deficit');
  });

  test('never more than was credited', () => {
    assert.equal(s().cap, '5000');
  });

  test('a charge that was never a top-up is left alone', () => {
    assert.equal(s().not_a_topup, 'not_a_topup');
    assert.equal(s().dispute_not_a_topup, 'not_a_topup');
  });
});

/* ── the deficit ──────────────────────────────────────────────────────────── */

describe('C6/C5 — a wallet that owes money does not spend, and repays first', () => {
  const s = () => scenario();

  test('spending is refused by the debit primitive itself', () => {
    assert.equal(s().spend_with_deficit, 'blocked:deficit');
    assert.match(blockMig, /select \* into v_block from public\.wallet_spend_block\(p_user\)/);
    // Checked before the idempotency claim, so a blocked attempt is retryable.
    const fn = blockMig.slice(blockMig.indexOf('create function public.wallet_debit_with_ledger'));
    assert.ok(fn.indexOf('wallet_spend_block') < fn.indexOf('on conflict (idempotency_key)'));
  });

  test('and a blocked attempt claims nothing', () => {
    assert.equal(s().blocked_claims_nothing, 'nothing claimed');
  });

  test('the next top-up repays the deficit before anything is spendable', () => {
    assert.equal(s().repaid, '8000');
    assert.equal(s().spendable, '2000');
    assert.equal(s().deficit_left, '0');
  });

  test('after which the wallet spends normally again', () => {
    assert.equal(s().spend_after_repay, 'allowed');
  });

  test('the balance is never driven negative', () => {
    assert.equal(s().balance_never_negative, 'none');
  });

  test('the client is told why, in words', () => {
    assert.match(ledgerHelper, /Your wallet is on hold while a card dispute is looked into/);
    assert.match(ledgerHelper, /Your wallet is on hold until a refunded top-up has been paid back/);
    assert.match(webWallet, /Wallet funds temporarily unavailable/);
    // And the till card is not offered on a wallet that would be refused.
    assert.match(webWallet, /\{deficit === 0 && <PayAtTillCard/);
  });
});

/* ── disputes ─────────────────────────────────────────────────────────────── */

describe('C7–C9 — disputes lock, winning clears, losing recovers once', () => {
  const s = () => scenario();

  test('opening a dispute locks the wallet', () => {
    assert.equal(s().dispute_open, 'blocked:dispute');
    assert.equal(s().spend_during_dispute, 'blocked:dispute');
  });

  test('but reverses nothing — a dispute is not yet a loss', () => {
    assert.equal(s().dispute_no_debt_yet, '0');
  });

  test('a redelivered "created" changes nothing', () => {
    assert.equal(s().dispute_open_repeat, 'open');
  });

  test('winning unlocks and leaves no debt', () => {
    assert.equal(s().dispute_won, 'unblocked');
  });

  test('and a late "created" cannot reopen a resolved dispute', () => {
    assert.equal(s().won_not_reopened, 'won');
  });

  test('losing recovers the money', () => {
    assert.equal(s().lost_taken, '5000');
  });

  test('exactly once, however many events describe it', () => {
    assert.equal(s().lost_repeat, 'no_change');
    assert.equal(s().refund_after_lost, 'no_double_recovery');
    assert.equal(s().lost_total, '5000');
  });

  test('the webhook drives all of it from Stripe’s own figures', () => {
    assert.match(webhook, /case 'charge\.dispute\.created':/);
    assert.match(webhook, /case 'charge\.dispute\.closed':/);
    assert.match(webhook, /p_cumulative: refundedSoFar/);
    assert.match(webhook, /const refundedSoFar = \(eventData\.amount_refunded as number\)/);
    assert.match(webhook, /p_kind: 'dispute_lost'/);
  });

  test('a failed recovery is thrown, not swallowed, so Stripe retries it', () => {
    const branch = webhook.slice(webhook.indexOf('wallet refund recovery failed'));
    assert.match(branch.slice(0, 200), /throw e;/);
  });

  test('notification failure never undoes a recovery', () => {
    const fn = webhook.slice(webhook.indexOf('async function notifyWalletRecovery'));
    assert.match(fn, /catch \(e\) \{\s*\n\s*console\.error\('\[stripe-webhook\] wallet recovery notify failed', e\);/);
  });
});

/* ── atomicity and reconciliation ─────────────────────────────────────────── */

describe('the books still balance', () => {
  const s = () => scenario();

  test('reconciliation is exact after a recovery', () => {
    assert.equal(s().reconciles_after_recovery, '0');
  });

  test('and after a deficit repayment', () => {
    assert.equal(s().reconciles_after_repay, '0');
    assert.equal(s().final_reconciles, '0');
  });

  test('because only the money that MOVED is in the ledger', () => {
    assert.match(recoveryMig, /if v_take > 0 then\s*\n\s*insert into public\.local_wallet_transactions/);
    assert.match(recoveryMig, /The ledger records money that moved: only the part actually taken/);
  });

  test('and the deficit is reported alongside, not folded in', () => {
    assert.match(blockMig, /deficit_pence  integer\n\)/);
    assert.match(blockMig, /coalesce\(b\.balance_pence, 0\) - coalesce\(l\.total, 0\)/);
  });

  test('recovery is one transaction — balance, ledger and claim together', () => {
    const fn = recoveryMig.slice(recoveryMig.indexOf('create or replace function public.wallet_recover_topup'),
                                 recoveryMig.indexOf('comment on function public.wallet_recover_topup'));
    assert.ok(fn.indexOf('for update') < fn.indexOf('insert into public.local_wallet_transactions'));
    assert.ok(fn.indexOf('insert into public.local_wallet_transactions') < fn.indexOf('update public.local_wallet_topup_recovery\n     set refunded_pence'));
  });
});

/* ── the existing core, unchanged ─────────────────────────────────────────── */

describe('F — nothing that already worked was weakened', () => {
  const s = () => scenario();

  test('one PaymentIntent still credits exactly once', () => {
    assert.equal(s().topup_first, 'credited');
    assert.equal(s().topup_replay, 'already');
    assert.equal(s().one_ledger_row, '1');
  });

  test('the webhook and the client confirm still converge on the same RPC', () => {
    assert.match(fulfilment, /\.rpc\('wallet_topup', \{ p_user: userId, p_amount: pi\.amount, p_pi: pi\.id \}\)/);
    assert.match(confirmFn, /\.rpc\('wallet_topup', \{ p_user: user\.id, p_amount: amount, p_pi: payment_intent_id \}\)/);
    assert.match(fulfilment, /case 'local_wallet_topup':/);
  });

  test('metadata binding is untouched', () => {
    assert.match(confirmFn, /intent\.metadata\?\.type !== 'local_wallet_topup'/);
    assert.match(confirmFn, /intent\.metadata\?\.user_id !== user\.id/);
    assert.match(confirmFn, /intent\.status !== 'succeeded'/);
  });

  test('a failed payment still credits nothing', () => {
    assert.match(intentFn, /outcome\.kind !== 'succeeded'/);
    assert.match(intentFn, /outcome\.kind === 'requires_action'/);
  });

  test('SCA still resumes the same intent', () => {
    assert.match(intentFn, /status: 'requires_action', clientSecret: outcome\.clientSecret, payment_intent_id: outcome\.id/);
    assert.match(webClient, /settleSavedCardPayment\(data as ScaStart\)/);
    assert.match(appApi, /settleSavedCardPayment\(data as PaymentStart\)/);
  });

  test('no wallet money function is client-callable', () => {
    assert.equal(s().client_exec, 'none');
  });

  test('and the recovery table is not client-readable', () => {
    assert.equal(s().recovery_table_client_read, 'none');
  });

  test('no Stripe or dispute identifier is displayed to anyone', () => {
    // Passing a PaymentIntent id back to the server is not exposing it. What
    // matters is what is DISPLAYED, so look inside text elements only.
    const shown = (src: string) =>
      [...code(src).matchAll(/<Text[^>]*>([\s\S]*?)<\/Text>/g)].map((m) => m[1]).join(' ') +
      [...code(src).matchAll(/<(?:p|span|h[1-6])[^>]*>([\s\S]*?)<\/(?:p|span|h[1-6])>/g)].map((m) => m[1]).join(' ');
    for (const [name, src] of [['web wallet', webWallet], ['web modal', webModal], ['app wallet', appWallet]] as const) {
      for (const leak of ['dispute_id', 'stripe_customer', 'charge_id', 'payment_intent']) {
        assert.ok(!shown(src).includes(leak), `${name} displays ${leak}`);
      }
    }
    // The modal hands the id straight to confirm, and shows a balance instead.
    assert.match(webModal, /confirmWalletTopUp\(res\.payment_intent_id\)/);
  });

  test('other paygates are unchanged', () => {
    for (const t of ['local_wallet_topup', 'unit_purchase', 'gift_purchase', 'event_tickets',
                     'hub_donation', 'hub_membership', 'product_order', 'shift_boost']) {
      assert.match(fulfilment, new RegExp(`case '${t}':`), `${t} lost its fulfiller`);
    }
  });

  test('production wallets still reconcile exactly', () => {
    const r = runSql(`select coalesce(sum(abs(delta_pence)),0)::text as d,
                             coalesce(sum(deficit_pence),0)::text   as def
                        from public.wallet_reconciliation();`)[0];
    assert.equal(r.d, '0', 'a production wallet no longer reconciles');
    assert.equal(r.def, '0', 'a production wallet carries an unexpected deficit');
  });
});
