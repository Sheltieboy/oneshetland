/**
 * wallet-loyalty-points.node.test.ts — points that survive a refund.
 *
 * tg_loyalty_earn_points never fired. It required amount_pence > 0 on a table
 * where spends are stored negative, and they were already negative before it
 * was written. It is retired here rather than corrected, because the sign was
 * the least of it: it awarded at the debit (before the merchant was paid and
 * before the purchase existed), on the GROSS debit rather than the business's
 * proceeds, with no link back to the spend that caused it — so nothing could
 * ever be reversed exactly.
 *
 * What replaces it:
 *
 *   loyalty_award_for_wallet_spend    called at fulfilment, reads every figure
 *                                     from the wallet ledger row itself
 *   loyalty_reverse_for_wallet_spend  keyed on that spend, called from inside
 *                                     wallet_reverse_debit, never able to fail
 *                                     a refund
 *
 * and a deficit, so a refund whose points have already been spent becomes a
 * debt against future earnings instead of a negative balance or a blocked
 * refund.
 *
 * SAFETY — ISOLATED DATABASE ONLY
 * Requires PASS_PROOF_DSN and refuses a DSN mentioning Supabase. Run by
 * `npm run test:isolated`. No production row is read or written.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(REPO_ROOT, 'supabase/migrations');
const FN = join(REPO_ROOT, 'supabase/functions');
const BASELINE = join(MIG, '20260623000000_baseline_remote_schema.sql');
const LEDGER = join(MIG, '20260820160000_wallet_atomic_ledger.sql');
const REMINDERS = join(MIG, '20260721020000_loyalty_reminders.sql');
const TIERS = join(MIG, '20260721030000_loyalty_reward_tiers.sql');
const FIX = join(MIG, '20261006120000_wallet_loyalty_points.sql');

const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
const src = (p: string) => readFileSync(p, 'utf8');
const args = (b: string) => [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', b];

function raw(body: string): string {
  try {
    return execFileSync(PSQL, args(body), { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}
async function rawAsync(body: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(PSQL, args(body), { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
    return stdout + stderr;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}
const TAG = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const value = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l)).pop() ?? '';
const scalar = (sql: string) => value(raw(sql));
const num = (sql: string) => Number(scalar(sql));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function slice(file: string, opener: string, closer: string): string {
  const s = src(file);
  const start = s.indexOf(opener);
  assert.notEqual(start, -1, `${opener} is gone from ${file}`);
  const end = s.indexOf(closer, start);
  assert.notEqual(end, -1, `no end for ${opener}`);
  return s.slice(start, end + closer.length);
}
function createTable(file: string, opener: string): string {
  const s = src(file);
  const start = s.indexOf(opener);
  assert.notEqual(start, -1, `${opener} is gone`);
  const open = s.indexOf('(', start);
  let d = 0, end = -1;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0) { end = i; break; } }
  }
  return s.slice(start, end + 1) + ';';
}

const OWNER = 'b0000000-0000-4000-8000-00000000000b';
const CUST  = 'c0000000-0000-4000-8000-00000000000c';
const BIZ   = 'd0000000-0000-4000-8000-00000000000d';
const PROG  = 'e0000000-0000-4000-8000-00000000000e';
const SPEND = '11110000-0000-4000-8000-000000000011';
const SPEND2 = '22220000-0000-4000-8000-000000000022';
const HUBSPEND = '33330000-0000-4000-8000-000000000033';

/** The real wallet ledger and the real loyalty tables, then the migration. */
function schema(opts: { pointsPerPound?: number; active?: boolean; type?: string } = {}) {
  const out = raw([
    'drop schema if exists public cascade; create schema public;',
    'drop schema if exists auth cascade; create schema auth;',
    'create table auth.users (id uuid primary key);',
    `do $$ begin
       if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
       if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
     end $$;`,
    'create table public.profiles (id uuid primary key);',
    createTable(BASELINE, 'CREATE TABLE public.local_businesses ('),
    'alter table public.local_businesses add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.local_wallet_balances ('),
    'alter table public.local_wallet_balances add primary key (user_id);',
    createTable(BASELINE, 'CREATE TABLE public.local_wallet_transactions ('),
    'alter table public.local_wallet_transactions add primary key (id);',
    `alter table public.local_wallet_transactions
       add column idempotency_key text,
       add column transfer_state text,
       add column reverses_transaction_id uuid references public.local_wallet_transactions(id);`,
    `create unique index local_wallet_transactions_idempotency_key
       on public.local_wallet_transactions (idempotency_key) where idempotency_key is not null;`,
    `alter table public.local_wallet_transactions add constraint local_wallet_transactions_transfer_state_check
       check (transfer_state is null or transfer_state in ('none','pending','sent','failed','unresolved','reversed'));`,
    createTable(BASELINE, 'CREATE TABLE public.local_loyalty_programs ('),
    'alter table public.local_loyalty_programs add primary key (id);',
    slice(TIERS, 'alter table public.local_loyalty_programs', ';'),
    createTable(BASELINE, 'CREATE TABLE public.local_loyalty_cards ('),
    'alter table public.local_loyalty_cards add primary key (id);',
    'alter table public.local_loyalty_cards add constraint local_loyalty_cards_user_id_program_id_key unique (user_id, program_id);',
    slice(REMINDERS, 'alter table public.local_loyalty_cards\n  add column if not exists reward_reminded_at', ';'),
    slice(REMINDERS, 'alter table public.local_loyalty_cards\n  add column if not exists nudge_reminded_at', ';'),
    slice(TIERS, 'alter table public.local_loyalty_cards\n  add column if not exists tiers_redeemed_upto', ';'),
    createTable(BASELINE, 'CREATE TABLE public.local_loyalty_transactions ('),
    'alter table public.local_loyalty_transactions add primary key (id);',
    `create or replace function public.business_meets_tier(p_biz uuid, p_tier text)
       returns boolean language sql stable as $$ select true $$;`,
    slice(LEDGER, 'create or replace function public.wallet_credit_with_ledger', '$$;'),
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `schema failed:\n${out.slice(0, 1400)}`);

  const p = raw(`insert into auth.users(id) values ('${OWNER}'),('${CUST}');
    insert into public.profiles(id) values ('${OWNER}'),('${CUST}');
    insert into public.local_businesses (id, owner_id, name, category, address)
      values ('${BIZ}','${OWNER}','Makkers','retail','Lerwick');
    insert into public.local_loyalty_programs (id, business_id, type, points_per_pound, points_for_pound, is_active)
      values ('${PROG}','${BIZ}','${opts.type ?? 'points'}',${opts.pointsPerPound ?? 10},100,${opts.active ?? true});
    insert into public.local_wallet_balances (user_id, balance_pence) values ('${CUST}', 10000);`);
  assert.doesNotMatch(p, /ERROR/i, `fixtures failed:\n${p.slice(0, 900)}`);
}

/** The migration under test, optionally mutated. */
const fixSql = () => [
  slice(FIX, 'alter table public.local_loyalty_transactions\n  add column if not exists source_transaction_id', ';'),
  slice(FIX, 'create unique index if not exists local_loyalty_tx_one_per_source_and_type', ';'),
  slice(FIX, 'alter table public.local_loyalty_cards\n  add column if not exists points_deficit', ';'),
  slice(FIX, 'do $$\nbegin\n  if not exists (select 1 from pg_constraint', 'end $$;'),
  slice(FIX, 'alter table public.local_loyalty_transactions\n  drop constraint if exists', ';'),
  slice(FIX, 'alter table public.local_loyalty_transactions\n  add constraint local_loyalty_transactions_type_check', ']));'),
  slice(FIX, 'create table if not exists public.loyalty_award_due', ');'),
  slice(FIX, 'create index if not exists loyalty_award_due_unsettled', ';'),
  slice(FIX, 'create or replace function public._loyalty_apply_award', '$$;'),
  slice(FIX, 'create or replace function public.loyalty_award_for_wallet_spend', '$$;'),
  slice(FIX, 'create or replace function public.loyalty_awards_outstanding', '$$;'),
  slice(FIX, 'create or replace function public.loyalty_recover_pending_awards', '$$;'),
  slice(FIX, 'create or replace function public.loyalty_reverse_for_wallet_spend', '$$;'),
  slice(FIX, 'create or replace function public.wallet_reverse_debit', '$$;'),
  slice(FIX, 'create or replace function public.loyalty_reversals_outstanding', '$$;'),
  slice(FIX, 'create or replace function public.loyalty_recover_outstanding_reversals', '$$;'),
].join('\n');
function installFix(mutate: (s: string) => string = (x) => x) {
  const out = raw(mutate(fixSql()));
  assert.doesNotMatch(out, /ERROR/i, `fix install failed:\n${out.slice(0, 1200)}`);
}
const grantsBlock = () => slice(FIX, 'do $$\ndeclare fn text;', 'end $$;');

/** A business wallet spend, as the wallet rail writes one. */
function spend(id: string, opts: { amount: number; fee?: number; cashback?: number; business?: string | null; state?: string }) {
  const biz = opts.business === null ? 'null' : `'${opts.business ?? BIZ}'`;
  const o = raw(`insert into public.local_wallet_transactions
    (id, user_id, business_id, type, amount_pence, platform_fee_pence, cashback_pence, description, idempotency_key, transfer_state)
    values ('${id}','${CUST}',${biz},'spend',${-opts.amount},${opts.fee ?? 0},${opts.cashback ?? 'null'},'Payment','k:${id}','${opts.state ?? 'sent'}');`);
  assert.doesNotMatch(o, /ERROR/i, `spend fixture failed:\n${o.slice(0, 700)}`);
}

const award = (id: string) => value(raw(`select public.loyalty_award_for_wallet_spend('${id}');`));
const reverseSpend = (id: string) =>
  value(raw(`select already_reversed from public.wallet_reverse_debit('${id}', 'refund', 'clawed_back');`));
const balance = () => num(`select coalesce(points_balance,0)::text from public.local_loyalty_cards limit 1;`);
const deficit = () => num(`select coalesce(points_deficit,0)::text from public.local_loyalty_cards limit 1;`);
const rowsOf = (type: string) => num(`select count(*)::text from public.local_loyalty_transactions where type='${type}';`);
const sumOf = (type: string) => num(`select coalesce(sum(amount),0)::text from public.local_loyalty_transactions where type='${type}';`);
const cards = () => num(`select count(*)::text from public.local_loyalty_cards;`);
/** Spend points as the redemption primitive would, without installing it. */
const spendPoints = (n: number) => raw(
  `update public.local_loyalty_cards set points_balance = points_balance - ${n};
   insert into public.local_loyalty_transactions (card_id, user_id, business_id, type, amount)
     select id, user_id, business_id, 'redeem', ${n} from public.local_loyalty_cards limit 1;`);

async function race(call: string): Promise<string[]> {
  const a = rawAsync(`begin; select ${call}; select pg_sleep(0.6); commit;`);
  await sleep(120);
  const b = rawAsync(`select ${call};`);
  return Promise.all([a, b]);
}
const okCount = (o: string[]) => o.filter((x) => /"ok"\s*:\s*true/.test(x)).length;

/* Each stage rebuilds, so state must be READ while it exists. */
const r = {
  netAward: '', netBalance: 0, netEarnRows: 0,
  cashbackAward: '',
  hubAward: '', hubCards: 0,
  noProgramme: '', notPro: '',
  dupAward: '', dupEarnRows: 0, dupBalance: 0,
  refundBalance: 0, refundDeficit: 0, refundReverseRows: 0, refundDeficitRows: 0, refundEarnKept: 0,
  partialBalance: 0, partialDeficit: 0, partialReverse: 0, partialDeficitAmt: 0,
  offsetPartialBalance: 0, offsetPartialDeficit: 0, offsetPartialPaid: 0,
  offsetFullBalance: 0, offsetFullDeficit: 0, offsetFullPaid: 0,
  dupRefundDeficit: 0, dupRefundRows: 0,
  raceAwardOk: 0, raceAwardRows: 0, raceAwardBalance: 0,
  earnRefundBalance: 0, earnRefundDeficit: 0, earnRefundEarnRows: 0, earnRefundRevRows: 0,
  awardAfterRefund: '', awardAfterRefundBalance: 0,
  redeemRefundBalance: 0, redeemRefundDeficit: 0,
  backfillPoints: 0, triggerGone: '',
  awardTierCheck: '', awardRaises: '',
  // Forced-failure fixture: what survives when the loyalty reversal blows up
  // inside a wallet refund that itself succeeds.
  failState: '', failWalletBal: 0, failRefundRows: 0, failEarnRows: 0,
  failPoints: 0, failReverseRows: 0, failDeficitRows: 0,
  failDetected: 0, retryResult: '', retryPoints: 0, retryDeficit: 0, retryDetected: 0,
  retryTwice: '', retryTwiceDeficit: 0, retryTwiceRows: 0,
  failAfterRedeemDeficit: 0, failAfterRedeemBalance: 0,
  raceRecoverOk: 0, raceRecoverRows: 0,
  awardPending: '', awardUnresolved: '', awardFailed: '', awardNone: '', awardSent: '',
  // Award-side failure and recovery
  awFailResult: '', awFailEarnRows: 0, awFailDue: 0, awFailPoints: 0,
  awRecovered: '', awRecoverPoints: 0, awRecoverDue: 0, awRecoverEarnRows: 0,
  awRecoverAgain: '', awRecoverAgainPoints: 0,
  awRateChangePoints: 0, awRateChangeDue: 0,
  awRaceOk: 0, awRaceEarnRows: 0, awRacePoints: 0,
  awNeverRaises: '',
  walletRefundStillWorks: '', walletBalanceAfter: 0,
};
const priv: Record<string, string> = {};
const anchors = { uniqueIndex: false, netBasis: false, deficitOffset: false, revIdempotent: false, cardLock: false,
                  detectClause: false, stateGate: false };
const mut = {
  m1EarnRows: 0, m1Balance: 0,
  m2Balance: 0,
  m3Deficit: 0, m3Balance: 0,
  m4Balance: 0,
  m5Detected: 0, m6Award: '',
};

before(async () => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');

  // ── Net-of-fee basis: £3.00 debit, £0.15 fee → earn on £2.85 ────────────
  schema({ pointsPerPound: 10 }); installFix();
  spend(SPEND, { amount: 300, fee: 15 });
  r.netAward = award(SPEND);
  r.netBalance = balance();
  r.netEarnRows = rowsOf('points_earn');

  // Cashback comes out of the merchant's transfer too, so it is not proceeds.
  schema({ pointsPerPound: 10 }); installFix();
  spend(SPEND, { amount: 300, fee: 15, cashback: 30 });
  r.cashbackAward = award(SPEND);

  // ── Ineligible spends ───────────────────────────────────────────────────
  schema({ pointsPerPound: 10 }); installFix();
  spend(HUBSPEND, { amount: 195, fee: 95, business: null });
  r.hubAward = award(HUBSPEND);
  r.hubCards = cards();

  schema({ pointsPerPound: 10, type: 'stamps' }); installFix();
  spend(SPEND, { amount: 300, fee: 15 });
  r.noProgramme = award(SPEND);

  schema({ pointsPerPound: 10 }); installFix();
  raw(`create or replace function public.business_meets_tier(p_biz uuid, p_tier text)
         returns boolean language sql stable as $$ select false $$;`);
  spend(SPEND, { amount: 300, fee: 15 });
  r.notPro = award(SPEND);

  // ── Duplicate completion ────────────────────────────────────────────────
  schema({ pointsPerPound: 10 }); installFix();
  spend(SPEND, { amount: 300, fee: 15 });
  award(SPEND);
  r.dupAward = award(SPEND);
  r.dupEarnRows = rowsOf('points_earn');
  r.dupBalance = balance();

  // ── Full refund before any redemption ───────────────────────────────────
  schema({ pointsPerPound: 10 }); installFix();
  spend(SPEND, { amount: 300, fee: 15 });
  award(SPEND);
  reverseSpend(SPEND);
  r.refundBalance = balance();
  r.refundDeficit = deficit();
  r.refundReverseRows = sumOf('points_reverse');
  r.refundDeficitRows = sumOf('points_deficit');
  r.refundEarnKept = rowsOf('points_earn');
  r.walletBalanceAfter = num(
    `select balance_pence::text from public.local_wallet_balances where user_id='${CUST}';`);

  // ── Refund after partial redemption → exact deficit ─────────────────────
  schema({ pointsPerPound: 10 }); installFix();
  spend(SPEND, { amount: 300, fee: 15 });
  award(SPEND);                 // 28 points
  spendPoints(20);              // 8 left
  reverseSpend(SPEND);
  r.partialBalance = balance();
  r.partialDeficit = deficit();
  r.partialReverse = sumOf('points_reverse');
  r.partialDeficitAmt = sumOf('points_deficit');

  // ── Future earning partially clears a deficit ───────────────────────────
  schema({ pointsPerPound: 10 }); installFix();
  spend(SPEND, { amount: 300, fee: 15 });
  award(SPEND); spendPoints(28); reverseSpend(SPEND);   // deficit 28, balance 0
  spend(SPEND2, { amount: 200, fee: 0 });               // earns 20
  award(SPEND2);
  r.offsetPartialBalance = balance();
  r.offsetPartialDeficit = deficit();
  r.offsetPartialPaid = sumOf('points_deficit_paid');

  // ── Future earning fully clears it and credits the remainder ────────────
  schema({ pointsPerPound: 10 }); installFix();
  spend(SPEND, { amount: 300, fee: 15 });
  award(SPEND); spendPoints(28); reverseSpend(SPEND);   // deficit 28
  spend(SPEND2, { amount: 500, fee: 0 });               // earns 50
  award(SPEND2);
  r.offsetFullBalance = balance();
  r.offsetFullDeficit = deficit();
  r.offsetFullPaid = sumOf('points_deficit_paid');

  // ── Duplicate refund does not deficit twice ─────────────────────────────
  schema({ pointsPerPound: 10 }); installFix();
  spend(SPEND, { amount: 300, fee: 15 });
  award(SPEND); spendPoints(28);
  reverseSpend(SPEND);
  raw(`select public.loyalty_reverse_for_wallet_spend('${SPEND}');`);   // a second attempt
  r.dupRefundDeficit = deficit();
  r.dupRefundRows = rowsOf('points_deficit');

  // ── Concurrency A: two fulfilment callbacks for one spend ───────────────
  schema({ pointsPerPound: 10 }); installFix();
  spend(SPEND, { amount: 300, fee: 15 });
  const ra = await race(`public.loyalty_award_for_wallet_spend('${SPEND}')`);
  r.raceAwardOk = okCount(ra);
  r.raceAwardRows = rowsOf('points_earn');
  r.raceAwardBalance = balance();

  // ── Concurrency B: earn racing the refund of the same spend ─────────────
  schema({ pointsPerPound: 10 }); installFix();
  spend(SPEND, { amount: 300, fee: 15 });
  await Promise.all([
    rawAsync(`begin; select public.loyalty_award_for_wallet_spend('${SPEND}'); select pg_sleep(0.5); commit;`),
    sleep(100).then(() => rawAsync(`select already_reversed from public.wallet_reverse_debit('${SPEND}','refund','clawed_back');`)),
  ]);
  r.earnRefundBalance = balance();
  r.earnRefundDeficit = deficit();
  r.earnRefundEarnRows = rowsOf('points_earn');
  r.earnRefundRevRows = rowsOf('points_reverse') + rowsOf('points_deficit');

  // ── The other order: the refund lands first, then a late fulfilment ─────
  schema({ pointsPerPound: 10 }); installFix();
  spend(SPEND, { amount: 300, fee: 15 });
  reverseSpend(SPEND);
  r.awardAfterRefund = award(SPEND);
  r.awardAfterRefundBalance = num(`select coalesce(sum(points_balance),0)::text from public.local_loyalty_cards;`);

  // ── Concurrency D: redemption racing the source refund ──────────────────
  schema({ pointsPerPound: 10 }); installFix();
  spend(SPEND, { amount: 300, fee: 15 });
  award(SPEND);
  await Promise.all([
    rawAsync(`begin; update public.local_loyalty_cards set points_balance = points_balance - 28;
              select pg_sleep(0.5); commit;`),
    sleep(100).then(() => rawAsync(`select already_reversed from public.wallet_reverse_debit('${SPEND}','refund','clawed_back');`)),
  ]);
  r.redeemRefundBalance = balance();
  r.redeemRefundDeficit = deficit();

  // ── No historical backfill: spends that predate the migration ───────────
  schema({ pointsPerPound: 10 });
  spend(SPEND, { amount: 300, fee: 15 });
  spend(SPEND2, { amount: 500, fee: 0 });
  installFix();                                   // the migration lands afterwards
  r.backfillPoints = rowsOf('points_earn');
  r.triggerGone = scalar(
    `select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='tg_loyalty_earn_points';`);

  // What the live tier tests will assert once this migration is applied: the
  // replacement carries the same tier condition and cannot raise into a
  // completed purchase. Proved here so those tests are not the first to find out.
  r.awardTierCheck = scalar(
    `select case when position('business_meets_tier(v_txn.business_id, ''pro'')' in pg_get_functiondef(p.oid)) > 0
              then 'yes' else 'no' end
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='loyalty_award_for_wallet_spend';`);
  r.awardRaises = scalar(
    `select case when pg_get_functiondef(p.oid) ~* 'raise[[:space:]]+exception' then 'yes' else 'no' end
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='loyalty_award_for_wallet_spend';`);

  // ── The wallet refund itself still works, loyalty or not ────────────────
  schema({ pointsPerPound: 10 }); installFix();
  spend(SPEND, { amount: 300, fee: 15 });
  r.walletRefundStillWorks = reverseSpend(SPEND);   // no award exists at all

  // ══ THE DANGEROUS CASE ══════════════════════════════════════════════════
  //
  // The loyalty call inside wallet_reverse_debit sits in an exception guard so
  // a refund can never fail over loyalty. A guard is a SUBTRANSACTION: if the
  // inner work raises, everything it did is rolled back and the outer
  // transaction carries on. So the question is not whether the refund survives
  // — it does — but what is left behind when the loyalty half does not.
  schema({ pointsPerPound: 10 }); installFix();
  spend(SPEND, { amount: 300, fee: 15 });
  award(SPEND);
  raw(`create function public.boom_ledger() returns trigger language plpgsql as $b$
       begin
         if new.type = 'points_reverse' then raise exception 'loyalty ledger is down'; end if;
         return new;
       end $b$;
       create trigger boom_ledger before insert on public.local_loyalty_transactions
         for each row execute function public.boom_ledger();`);
  reverseSpend(SPEND);                       // the refund must still succeed
  r.failState = scalar(`select transfer_state from public.local_wallet_transactions where id='${SPEND}';`);
  r.failWalletBal = num(`select balance_pence::text from public.local_wallet_balances where user_id='${CUST}';`);
  r.failRefundRows = num(
    `select count(*)::text from public.local_wallet_transactions where reverses_transaction_id='${SPEND}';`);
  r.failEarnRows = rowsOf('points_earn');
  r.failPoints = balance();
  r.failReverseRows = rowsOf('points_reverse');
  r.failDeficitRows = rowsOf('points_deficit');
  // Is the incomplete state derivable from what is already on disk?
  r.failDetected = num(`select count(*)::text from public.loyalty_reversals_outstanding();`);

  // ── Loyalty-only retry, after the money has already gone back ────────────
  raw(`drop trigger boom_ledger on public.local_loyalty_transactions;`);
  r.retryResult = value(raw(`select public.loyalty_reverse_for_wallet_spend('${SPEND}');`));
  r.retryPoints = balance();
  r.retryDeficit = deficit();
  r.retryDetected = num(`select count(*)::text from public.loyalty_reversals_outstanding();`);
  // And again — nothing further may happen.
  r.retryTwice = value(raw(`select public.loyalty_reverse_for_wallet_spend('${SPEND}');`));
  r.retryTwiceDeficit = deficit();
  r.retryTwiceRows = rowsOf('points_reverse') + rowsOf('points_deficit');

  // ── The same failure, but the points had already been spent ─────────────
  schema({ pointsPerPound: 10 }); installFix();
  spend(SPEND, { amount: 300, fee: 15 });
  award(SPEND); spendPoints(28);
  raw(`create function public.boom_card() returns trigger language plpgsql as $b$
       begin raise exception 'loyalty card is down'; end $b$;
       create trigger boom_card before update on public.local_loyalty_cards
         for each row execute function public.boom_card();`);
  reverseSpend(SPEND);
  raw(`drop trigger boom_card on public.local_loyalty_cards;`);
  raw(`select public.loyalty_recover_outstanding_reversals(100);`);
  r.failAfterRedeemDeficit = deficit();
  r.failAfterRedeemBalance = balance();

  // ── Two recovery runs at once produce one result ────────────────────────
  schema({ pointsPerPound: 10 }); installFix();
  spend(SPEND, { amount: 300, fee: 15 });
  award(SPEND);
  raw(`create function public.boom_ledger2() returns trigger language plpgsql as $b$
       begin
         if new.type = 'points_reverse' then raise exception 'down'; end if;
         return new;
       end $b$;
       create trigger boom_ledger2 before insert on public.local_loyalty_transactions
         for each row execute function public.boom_ledger2();`);
  reverseSpend(SPEND);
  raw(`drop trigger boom_ledger2 on public.local_loyalty_transactions;`);
  const rr = await race(`public.loyalty_reverse_for_wallet_spend('${SPEND}')`);
  r.raceRecoverOk = okCount(rr);
  r.raceRecoverRows = rowsOf('points_reverse') + rowsOf('points_deficit');

  // ── The award refuses a spend that is not settled ───────────────────────
  schema({ pointsPerPound: 10 }); installFix();
  for (const [id, st, key] of [[SPEND, 'pending', 'awardPending'], [SPEND2, 'unresolved', 'awardUnresolved']] as const) {
    spend(id, { amount: 300, fee: 15, state: st });
    (r as Record<string, unknown>)[key] = award(id);
  }
  schema({ pointsPerPound: 10 }); installFix();
  spend(SPEND, { amount: 300, fee: 15, state: 'failed' });
  r.awardFailed = award(SPEND);
  // Both settled states still award: 'sent' is every real rail, 'none' means
  // no transfer was ever needed.
  schema({ pointsPerPound: 10 }); installFix();
  spend(SPEND, { amount: 300, fee: 15, state: 'sent' });
  r.awardSent = award(SPEND);
  schema({ pointsPerPound: 10 }); installFix();
  spend(SPEND, { amount: 300, fee: 15, state: 'none' });
  r.awardNone = award(SPEND);

  // ══ AWARD-SIDE FAILURE ══════════════════════════════════════════════════
  //
  // The purchase has already succeeded. Applying the points fails. Nothing may
  // be lost, and nothing may be recomputed later at a rate the business
  // changed in the meantime.
  const boomEarn = `create function public.boom_earn() returns trigger language plpgsql as $b$
       begin
         if new.type = 'points_earn' then raise exception 'loyalty ledger is down'; end if;
         return new;
       end $b$;
       create trigger boom_earn before insert on public.local_loyalty_transactions
         for each row execute function public.boom_earn();`;

  schema({ pointsPerPound: 10 }); installFix();
  spend(SPEND, { amount: 300, fee: 15 });
  raw(boomEarn);
  r.awFailResult = award(SPEND);
  // 'ERROR:' with the colon — the JSON payload legitimately carries an "error" key.
  r.awNeverRaises = /ERROR:/.test(r.awFailResult) ? 'raised' : 'returned';
  r.awFailEarnRows = rowsOf('points_earn');
  r.awFailPoints = num(`select coalesce(sum(points_balance),0)::text from public.local_loyalty_cards;`);
  r.awFailDue = num(`select count(*)::text from public.loyalty_awards_outstanding();`);

  // Recovery, after the fault clears — and after the business changes its rate.
  raw(`drop trigger boom_earn on public.local_loyalty_transactions;`);
  raw(`update public.local_loyalty_programs set points_per_pound = 20;`);
  r.awRecovered = value(raw(`select public.loyalty_recover_pending_awards(100);`));
  r.awRecoverPoints = num(`select coalesce(sum(points_balance),0)::text from public.local_loyalty_cards;`);
  r.awRecoverDue = num(`select count(*)::text from public.loyalty_awards_outstanding();`);
  r.awRecoverEarnRows = rowsOf('points_earn');
  r.awRateChangePoints = r.awRecoverPoints;
  // A second recovery does nothing.
  r.awRecoverAgain = value(raw(`select public.loyalty_recover_pending_awards(100);`));
  r.awRecoverAgainPoints = num(`select coalesce(sum(points_balance),0)::text from public.local_loyalty_cards;`);
  r.awRateChangeDue = num(`select count(*)::text from public.loyalty_awards_outstanding();`);

  // Two concurrent recoveries award once.
  schema({ pointsPerPound: 10 }); installFix();
  spend(SPEND, { amount: 300, fee: 15 });
  raw(boomEarn);
  award(SPEND);
  raw(`drop trigger boom_earn on public.local_loyalty_transactions;`);
  const ar = await race(`public.loyalty_recover_pending_awards(100)`);
  r.awRaceOk = okCount(ar);
  r.awRaceEarnRows = rowsOf('points_earn');
  r.awRacePoints = num(`select coalesce(sum(points_balance),0)::text from public.local_loyalty_cards;`);

  // ── Privileges ──────────────────────────────────────────────────────────
  schema({ pointsPerPound: 10 }); installFix();
  const g = raw(grantsBlock());
  assert.doesNotMatch(g, /ERROR/i, `grants failed:\n${g.slice(0, 600)}`);
  for (const fn of ['loyalty_award_for_wallet_spend', 'loyalty_reverse_for_wallet_spend',
                    'loyalty_reversals_outstanding', 'loyalty_recover_outstanding_reversals',
                    '_loyalty_apply_award', 'loyalty_awards_outstanding', 'loyalty_recover_pending_awards']) {
    priv[fn] = scalar(
      `select string_agg(r || ':' || case when has_function_privilege(r, p.oid, 'execute') then 'yes' else 'no' end, ' ')
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
              unnest(array['anon','authenticated','service_role']) r
        where n.nspname='public' and p.proname = '${fn}';`);
  }

  // ── Mutations ───────────────────────────────────────────────────────────
  const uniqueIdx = `create unique index if not exists local_loyalty_tx_one_per_source_and_type
  on public.local_loyalty_transactions (source_transaction_id, type)
  where source_transaction_id is not null;`;
  const netBasis = `  v_proceeds := abs(coalesce(v_txn.amount_pence, 0))
              - coalesce(v_txn.platform_fee_pence, 0)
              - coalesce(v_txn.cashback_pence, 0);`;
  const deficitOffset = `  v_paid   := least(coalesce(v_card.points_deficit, 0), p_points);`;
  const revIdem = `  if exists (select 1 from public.local_loyalty_transactions
              where source_transaction_id = p_wallet_txn
                and type in ('points_reverse', 'points_deficit')) then`;
  const cardLock = `  select * into v_card from public.local_loyalty_cards where id = v_earn.card_id for update;`;
  const detectClause = `     and not exists (select 1 from public.local_loyalty_transactions x
                      where x.source_transaction_id = e.source_transaction_id
                        and x.type in ('points_reverse', 'points_deficit'))`;
  const stateGate = `  if coalesce(v_txn.transfer_state, 'none') not in ('sent', 'none') then`;
  const f = fixSql();
  anchors.uniqueIndex = f.includes(uniqueIdx);
  anchors.netBasis = f.includes(netBasis);
  anchors.deficitOffset = f.includes(deficitOffset);
  anchors.revIdempotent = f.includes(revIdem);
  anchors.cardLock = f.includes(cardLock);
  anchors.detectClause = f.includes(detectClause);
  anchors.stateGate = f.includes(stateGate);

  // M1 — the source unique index removed, and the award's own guard with it.
  schema({ pointsPerPound: 10 });
  installFix((x) => x.replace(uniqueIdx, '').replace(
    `  if exists (select 1 from public.local_loyalty_transactions
              where source_transaction_id = p_source and type = 'points_earn') then
    update public.loyalty_award_due set settled_at = coalesce(settled_at, now())
     where source_transaction_id = p_source;
    return jsonb_build_object('ok', true, 'already_awarded', true,
                              'points_balance', v_card.points_balance,
                              'points_deficit', v_card.points_deficit);
  end if;`, ''));
  spend(SPEND, { amount: 300, fee: 15 });
  award(SPEND); award(SPEND);
  mut.m1EarnRows = rowsOf('points_earn');
  mut.m1Balance = balance();

  // M2 — the net basis replaced by the gross debit the old trigger used.
  schema({ pointsPerPound: 10 });
  installFix((x) => x.replace(netBasis, '  v_proceeds := abs(coalesce(v_txn.amount_pence, 0));'));
  spend(SPEND, { amount: 300, fee: 15 });
  award(SPEND);
  mut.m2Balance = balance();

  // M3 — the deficit offset removed: an earning ignores what is owed.
  schema({ pointsPerPound: 10 });
  installFix((x) => x.replace(deficitOffset, '  v_paid   := 0;'));
  spend(SPEND, { amount: 300, fee: 15 });
  award(SPEND); spendPoints(28); reverseSpend(SPEND);
  spend(SPEND2, { amount: 200, fee: 0 });
  award(SPEND2);
  mut.m3Deficit = deficit();
  mut.m3Balance = balance();

  // M5 — the detection's "and nothing reversed it" clause removed: a spend
  // that HAS been recovered still reports as outstanding, so the recovery
  // driver would work on it for ever.
  schema({ pointsPerPound: 10 });
  installFix((x) => x.replace(detectClause, ''));
  spend(SPEND, { amount: 300, fee: 15 });
  award(SPEND);
  reverseSpend(SPEND);                        // reverses cleanly, nothing outstanding
  mut.m5Detected = num(`select count(*)::text from public.loyalty_reversals_outstanding();`);

  // M6 — the award's settled-state gate removed: an early caller mints points
  // against money that is still in motion.
  schema({ pointsPerPound: 10 });
  installFix((x) => x.replace(stateGate, '  if false then'));
  spend(SPEND, { amount: 300, fee: 15, state: 'unresolved' });
  mut.m6Award = award(SPEND);

  // M4 — the reversal's idempotency guard removed, and the unique index with
  // it. The index alone would turn a second reversal into an error rather than
  // a second deficit, so removing only the guard measures the index; removing
  // both is what measures the guard.
  schema({ pointsPerPound: 10 });
  installFix((x) => x.replace(revIdem, '  if false then').replace(uniqueIdx, ''));
  spend(SPEND, { amount: 300, fee: 15 });
  award(SPEND); spendPoints(28);
  reverseSpend(SPEND);
  raw(`select public.loyalty_reverse_for_wallet_spend('${SPEND}');`);
  mut.m4Balance = deficit();
});

describe('the earning basis is the business proceeds', () => {
  test('£3.00 debit less £0.15 fee earns on £2.85', () => {
    assert.match(r.netAward, /"proceeds_pence"\s*:\s*285/);
    assert.match(r.netAward, /"points_earned"\s*:\s*28/);   // floor(2.85 × 10)
    assert.equal(r.netBalance, 28);
    assert.equal(r.netEarnRows, 1);
  });
  test('business-funded cashback is not proceeds either', () => {
    // 300 − 15 fee − 30 cashback = 255 → floor(2.55 × 10) = 25
    assert.match(r.cashbackAward, /"proceeds_pence"\s*:\s*255/);
    assert.match(r.cashbackAward, /"points_earned"\s*:\s*25/);
  });
});

describe('ineligible spends earn nothing', () => {
  test('a hub spend with no business_id is refused', () => {
    assert.match(r.hubAward, /not_a_business_spend/);
    assert.equal(r.hubCards, 0, 'no card should even be opened');
  });
  test('a business with no points programme earns nothing', () => {
    assert.match(r.noProgramme, /no_points_program/);
  });
  test('a business below Pro earns nothing', () => {
    assert.match(r.notPro, /business_not_pro/);
  });
});

describe('one spend, one award', () => {
  test('a repeated fulfilment reports already awarded', () => {
    assert.match(r.dupAward, /already_awarded/);
  });
  test('and does not double-award', () => {
    assert.equal(r.dupEarnRows, 1);
    assert.equal(r.dupBalance, 28);
  });
  test('two concurrent fulfilment callbacks award exactly once', () => {
    assert.equal(r.raceAwardOk, 2, 'both calls answer; only one awards');
    assert.equal(r.raceAwardRows, 1);
    assert.equal(r.raceAwardBalance, 28);
  });
});

describe('refund before any redemption', () => {
  test('the full earned points come back off', () => {
    assert.equal(r.refundBalance, 0);
    assert.equal(r.refundReverseRows, 28);
  });
  test('and no deficit is created', () => {
    assert.equal(r.refundDeficit, 0);
    assert.equal(r.refundDeficitRows, 0);
  });
  test('the original earn row is kept, not erased', () => {
    assert.equal(r.refundEarnKept, 1);
  });
  test('and the customer got their whole payment back, not the net', () => {
    // Earned on £2.85, refunded £3.00. The customer is made whole on what they
    // paid; the platform fee is the platform's to lose.
    assert.equal(r.walletBalanceAfter, 10300);
  });
});

describe('refund after the points were partly spent', () => {
  test('what is left is taken, and the shortfall becomes a deficit', () => {
    assert.equal(r.partialBalance, 0);
    assert.equal(r.partialDeficit, 20);     // 28 clawed, 8 available
    assert.equal(r.partialReverse, 8);
    assert.equal(r.partialDeficitAmt, 20);
  });
});

describe('future earnings pay the deficit down first', () => {
  test('an earning smaller than the debt clears part of it and credits nothing', () => {
    assert.equal(r.offsetPartialDeficit, 8);   // 28 owed, 20 earned
    assert.equal(r.offsetPartialBalance, 0);
    assert.equal(r.offsetPartialPaid, 20);
  });
  test('an earning larger than the debt clears it and banks the remainder', () => {
    assert.equal(r.offsetFullDeficit, 0);      // 28 owed, 50 earned
    assert.equal(r.offsetFullBalance, 22);
    assert.equal(r.offsetFullPaid, 28);
  });
});

describe('a refund cannot be applied twice', () => {
  test('a second reversal changes nothing', () => {
    assert.equal(r.dupRefundDeficit, 28);
    assert.equal(r.dupRefundRows, 1);
  });
});

describe('concurrency', () => {
  test('earn racing its own refund settles deterministically', () => {
    assert.equal(r.earnRefundEarnRows, 1);
    assert.equal(r.earnRefundBalance, 0, 'no free points survive the refund');
    assert.equal(r.earnRefundDeficit, 0);
    assert.equal(r.earnRefundRevRows, 1, 'reversed exactly once');
  });
  test('a late fulfilment cannot award on an already-refunded spend', () => {
    assert.match(r.awardAfterRefund, /spend_already_reversed/);
    assert.equal(r.awardAfterRefundBalance, 0);
  });
  test('redemption racing the refund leaves no negative balance', () => {
    assert.equal(r.redeemRefundBalance, 0);
    assert.equal(r.redeemRefundDeficit, 28, 'the whole award became debt');
  });
});

describe('the dead trigger, and no backfill', () => {
  test('tg_loyalty_earn_points is gone', () => {
    assert.equal(r.triggerGone, '0');
  });
  test('spends that predate the migration earn nothing retroactively', () => {
    assert.equal(r.backfillPoints, 0);
  });
});

describe('the replacement keeps what the trigger was holding', () => {
  test('it still refuses a business below Pro', () => {
    assert.equal(r.awardTierCheck, 'yes');
  });
  test('and it cannot raise into a purchase that is already paid for', () => {
    assert.equal(r.awardRaises, 'no');
  });
});

describe('a wallet refund is never held up by loyalty', () => {
  test('a spend that earned nothing still reverses cleanly', () => {
    assert.equal(r.walletRefundStillWorks, 'f');
  });
});

describe('privileges', () => {
  for (const fn of ['loyalty_award_for_wallet_spend', 'loyalty_reverse_for_wallet_spend']) {
    test(`${fn} is service_role only`, () => {
      assert.equal(priv[fn], 'anon:no authenticated:no service_role:yes');
    });
  }
});

describe('the suite is anchored to the real migration', () => {
  test('the source unique index is where the mutation expects it', () => { assert.ok(anchors.uniqueIndex); });
  test('the net-of-fee basis is where the mutation expects it', () => { assert.ok(anchors.netBasis); });
  test('the deficit offset is where the mutation expects it', () => { assert.ok(anchors.deficitOffset); });
  test('the reversal idempotency guard is where the mutation expects it', () => { assert.ok(anchors.revIdempotent); });
  test('the card row lock is where the mutation expects it', () => { assert.ok(anchors.cardLock); });
});

describe('mutations — each protection is load-bearing', () => {
  test('M1 removing the source uniqueness double-awards one spend', () => {
    assert.equal(mut.m1EarnRows, 2);
    assert.equal(mut.m1Balance, 56);
  });
  test('M2 earning on the gross debit overpays the customer', () => {
    assert.equal(mut.m2Balance, 30, 'earned on £3.00, not the £2.85 the business received');
  });
  test('M3 ignoring the deficit hands back points that are owed', () => {
    assert.equal(mut.m3Deficit, 28, 'the debt is untouched');
    assert.equal(mut.m3Balance, 20, 'and the new earning became spendable anyway');
  });
  test('M4 removing reversal idempotency deficits twice', () => {
    assert.equal(mut.m4Balance, 56);
  });
});

describe('a loyalty failure cannot silently leave free points', () => {
  test('the wallet refund still completes in full', () => {
    assert.equal(r.failState, 'reversed');
    assert.equal(r.failRefundRows, 1);
    assert.equal(r.failWalletBal, 10300);
  });
  test('the loyalty half is rolled back entirely — the guard is a subtransaction', () => {
    assert.equal(r.failEarnRows, 1, 'the award survives');
    assert.equal(r.failPoints, 28, 'and so do the points');
    assert.equal(r.failReverseRows, 0);
    assert.equal(r.failDeficitRows, 0);
  });
  test('but the incomplete state is derivable, not lost', () => {
    assert.equal(r.failDetected, 1, 'loyalty_reversals_outstanding must see it');
  });
});

describe('the loyalty-only retry, after the money has gone back', () => {
  test('it completes without touching the financial refund again', () => {
    assert.match(r.retryResult, /"ok"\s*:\s*true/);
    assert.equal(r.retryPoints, 0);
    assert.equal(r.retryDeficit, 0);
  });
  test('and the wallet spend is no longer outstanding', () => {
    assert.equal(r.retryDetected, 0);
  });
  test('a second retry does nothing at all', () => {
    assert.match(r.retryTwice, /already_reversed/);
    assert.equal(r.retryTwiceDeficit, 0);
    assert.equal(r.retryTwiceRows, 1, 'exactly one reversal row, ever');
  });
  test('recovery after the points were spent creates the right deficit', () => {
    assert.equal(r.failAfterRedeemBalance, 0);
    assert.equal(r.failAfterRedeemDeficit, 28);
  });
  test('two concurrent recoveries produce one result', () => {
    assert.equal(r.raceRecoverOk, 2, 'both answer');
    assert.equal(r.raceRecoverRows, 1, 'one reversal');
  });
});

describe('the award refuses an unsettled spend', () => {
  test('pending, unresolved and failed are all refused', () => {
    assert.match(r.awardPending, /spend_not_settled/);
    assert.match(r.awardUnresolved, /spend_not_settled/);
    assert.match(r.awardFailed, /spend_not_settled/);
  });
  test('sent and none — the states every real rail reaches — still award', () => {
    assert.match(r.awardSent, /"points_earned"\s*:\s*28/);
    assert.match(r.awardNone, /"points_earned"\s*:\s*28/);
  });
});

describe('the recovery protections are load-bearing', () => {
  test('the detection clause is where the mutation expects it', () => { assert.ok(anchors.detectClause); });
  test('the settled-state gate is where the mutation expects it', () => { assert.ok(anchors.stateGate); });

  test('M5 removing the "nothing reversed it" clause reports recovered spends for ever', () => {
    assert.equal(mut.m5Detected, 1, 'a fully reversed spend still looks outstanding');
  });
  test('M6 removing the settled-state gate mints points on unresolved money', () => {
    assert.match(mut.m6Award, /"points_earned"\s*:\s*28/);
  });
});

describe('an award failure after a successful purchase', () => {
  test('the award never raises — the callers are safe by construction', () => {
    assert.equal(r.awNeverRaises, 'returned',
      'supabase-js returns a Postgres error rather than throwing, so a caller try/catch would not have caught one');
    assert.match(r.awFailResult, /"error"\s*:\s*"award_failed"/);
  });
  test('nothing was applied', () => {
    assert.equal(r.awFailEarnRows, 0);
    assert.equal(r.awFailPoints, 0);
  });
  test('but what was owed is recorded, with the figures as they stood', () => {
    assert.equal(r.awFailDue, 1);
    assert.match(r.awFailResult, /"points_owed"\s*:\s*28/);
    assert.match(r.awFailResult, /"recorded"\s*:\s*true/);
  });
});

describe('the award recovery uses the snapshot, not a later rate', () => {
  test('it recovers exactly one award', () => {
    assert.match(r.awRecovered, /"recovered"\s*:\s*1/);
    assert.equal(r.awRecoverEarnRows, 1);
  });
  test('and awards the 28 owed, not the 57 the doubled rate would give', () => {
    assert.equal(r.awRateChangePoints, 28,
      'points_per_pound was doubled to 20 between the failure and the recovery');
  });
  test('the entitlement is then settled and no longer outstanding', () => {
    assert.equal(r.awRecoverDue, 0);
  });
  test('a second recovery is a no-op', () => {
    assert.match(r.awRecoverAgain, /"recovered"\s*:\s*0/);
    assert.equal(r.awRecoverAgainPoints, 28);
    assert.equal(r.awRateChangeDue, 0);
  });
  test('two concurrent recoveries award once between them', () => {
    assert.equal(r.awRaceOk, 2, 'both answer');
    assert.equal(r.awRaceEarnRows, 1);
    assert.equal(r.awRacePoints, 28);
  });
});
