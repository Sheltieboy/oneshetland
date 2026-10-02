/**
 * wallet-push-funding.node.test.ts
 *
 * Stripe offers this platform only a PUSH bank transfer for the Payments
 * balance (FPS / BACS), so Wallet reserve funding is: OneShetland calculates
 * the amount, shows the beneficiary details to platform admins, records the
 * operator's intent ("Create funding instructions" — BEFORE any money is sent), and recognises the money
 * when it reaches Stripe. This proves:
 *
 *   1. the arrival-matching rules — exact amount, GBP, not before the session,
 *      one Stripe object per session — and that ordinary Stripe revenue can
 *      NEVER reconcile a funding transfer
 *   2. awaiting_funds → pending_at_stripe → available (and failed / expired)
 *   3. the bank details are admin-only, never in the snapshot payload, never
 *      logged, never read by a client, and audited without storing values
 *   4. a funding session moves no money: no Stripe write, no Topup, no
 *      customer Wallet balance or ledger access
 *   5. the recommended amount is computed live, never hard-coded
 *   6. the Wallet-spend preflight is untouched
 *
 * No Stripe write is made by this file. The live checks insert throwaway
 * session rows directly and remove them in after().
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  candidateFromTopup, candidateFromBalanceTransaction, pickFundingMatch, nextSessionState,
  isEligibleCandidate, CLOCK_SLACK_SECONDS,
  type FundingCandidate, type MatchableSession,
} from '../functions/_shared/wallet-funding-match.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

const TEST_USER = 'eb599396-6e9c-4c49-ae67-cb60fbc02bac';
const TEST_PREFIX = 'test-push-funding-';

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
  if (parsed._tag === 'Error' || parsed.error) {
    throw new Error(`supabase db query returned an error: ${JSON.stringify(parsed.error).slice(0, 400)}`);
  }
  return parsed.rows ?? [];
}


/** Source of one top-level component function in the panel (up to the next top-level function). */
function view(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `component ${name} not found`);
  const next = src.indexOf('\nfunction ', start + 10);
  return src.slice(start, next === -1 ? undefined : next);
}

const T0 = '2026-10-10T12:00:00.000Z';
const t0Unix = Math.floor(new Date(T0).getTime() / 1000);
const session = (over: Partial<MatchableSession> = {}): MatchableSession => ({
  status: 'awaiting_funds', requested_amount_pence: 14507, created_at: T0, matched_ref: null, ...over,
});
const topup = (over: Record<string, unknown> = {}) => candidateFromTopup({
  id: 'tu_1', amount: 14507, currency: 'gbp', created: t0Unix + 3600, status: 'pending', ...over,
});

/* ── 1. Matching rules ────────────────────────────────────────────────────── */

describe('arrival matching: only a genuine funding credit of exactly the expected amount reconciles', () => {
  test('a pending Topup of the exact amount, after the session, matches', () => {
    const m = pickFundingMatch(session(), [topup()!], new Set());
    assert.equal(m?.ref, 'tu_1');
  });

  test('a different amount does not match (no "close enough")', () => {
    assert.equal(pickFundingMatch(session(), [topup({ amount: 14506 })!], new Set()), null);
    assert.equal(pickFundingMatch(session(), [topup({ amount: 20000 })!], new Set()), null);
  });

  test('a credit created before the session (beyond clock slack) does not match', () => {
    const early = topup({ created: t0Unix - CLOCK_SLACK_SECONDS - 1 })!;
    assert.equal(pickFundingMatch(session(), [early], new Set()), null);
    const withinSlack = topup({ created: t0Unix - CLOCK_SLACK_SECONDS + 1 })!;
    assert.ok(pickFundingMatch(session(), [withinSlack], new Set()));
  });

  test('a non-GBP credit does not match', () => {
    assert.equal(pickFundingMatch(session(), [topup({ currency: 'usd' })!], new Set()), null);
  });

  test('a Stripe object already claimed by another session / programmatic Topup cannot match again', () => {
    assert.equal(pickFundingMatch(session(), [topup()!], new Set(['tu_1'])), null);
  });

  test('a session keeps its own earlier match even if another equal-amount credit appears', () => {
    const own = topup({ id: 'tu_own', created: t0Unix + 100 })!;
    const other = topup({ id: 'tu_other', created: t0Unix + 50 })!;
    const m = pickFundingMatch(session({ matched_ref: 'tu_own', status: 'pending_at_stripe' }), [other, own], new Set());
    assert.equal(m?.ref, 'tu_own');
  });

  test('a Topup object is preferred over a raw balance transaction; then the earliest', () => {
    const bt = candidateFromBalanceTransaction({ id: 'txn_1', amount: 14507, currency: 'gbp', created: t0Unix + 10, type: 'adjustment', status: 'available' })!;
    const tu = topup({ created: t0Unix + 500 })!;
    assert.equal(pickFundingMatch(session(), [bt, tu], new Set())?.kind, 'topup');
  });
});

describe('unrelated Stripe revenue can never reconcile a funding transfer', () => {
  const nonFundingTypes = ['charge', 'payment', 'stripe_fee', 'application_fee', 'refund', 'payment_refund', 'transfer', 'payout', 'dispute'];
  for (const type of nonFundingTypes) {
    test(`a ${type} balance transaction of the exact funding amount is not even a candidate`, () => {
      const bt = candidateFromBalanceTransaction({ id: `txn_${type}`, amount: 14507, currency: 'gbp', created: t0Unix + 60, type, status: 'available' });
      assert.equal(bt, null);
    });
  }

  test('a negative adjustment of the exact amount is not a candidate', () => {
    assert.equal(candidateFromBalanceTransaction({ id: 'txn_n', amount: -14507, currency: 'gbp', created: t0Unix + 60, type: 'adjustment', status: 'available' }), null);
  });

  test('a stream of card revenue (incl. one of exactly the funding amount) leaves the session awaiting', () => {
    const revenue = [14507, 14507, 5000, 99, 14507]
      .map((amount, i) => candidateFromBalanceTransaction({ id: `txn_c${i}`, amount, currency: 'gbp', created: t0Unix + 60 + i, type: 'charge', status: 'available' }))
      .filter((c): c is FundingCandidate => c !== null);
    assert.equal(revenue.length, 0);
    const match = pickFundingMatch(session(), revenue, new Set());
    assert.equal(match, null);
    assert.equal(nextSessionState(session(), match, new Date(t0Unix * 1000 + 3600_000), 168), null, 'still awaiting_funds');
  });

  test('a Topup with an unrecognised status is not a candidate', () => {
    assert.equal(candidateFromTopup({ id: 'tu_x', amount: 14507, currency: 'gbp', created: t0Unix, status: 'weird' }), null);
  });
});

/* ── 2. State progression ─────────────────────────────────────────────────── */

describe('session states: awaiting_funds → pending_at_stripe → available (and failed / expired)', () => {
  const now = new Date(t0Unix * 1000 + 2 * 3600_000);

  test('awaiting_funds with no match stays awaiting_funds inside the expiry window', () => {
    assert.equal(nextSessionState(session(), null, now, 168), null);
  });

  test('a pending Topup moves awaiting_funds → pending_at_stripe', () => {
    assert.equal(nextSessionState(session(), topup({ status: 'pending' })!, now, 168)?.status, 'pending_at_stripe');
  });

  test('a succeeded Topup moves straight to available, or pending_at_stripe → available', () => {
    assert.equal(nextSessionState(session(), topup({ status: 'succeeded' })!, now, 168)?.status, 'available');
    assert.equal(
      nextSessionState(session({ status: 'pending_at_stripe', matched_ref: 'tu_1' }), topup({ status: 'succeeded' })!, now, 168)?.status,
      'available',
    );
  });

  test('no change is reported when the state is already correct', () => {
    assert.equal(nextSessionState(session({ status: 'pending_at_stripe', matched_ref: 'tu_1' }), topup({ status: 'pending' })!, now, 168), null);
  });

  test('failed / canceled / reversed funding is reported as failed with a note', () => {
    for (const status of ['failed', 'canceled', 'reversed']) {
      const next = nextSessionState(session(), topup({ status })!, now, 168);
      assert.equal(next?.status, 'failed');
      assert.ok(next?.note);
    }
  });

  test('an awaiting session with no credit expires (unresolved) only after the configured window', () => {
    const justInside = new Date(t0Unix * 1000 + 168 * 3600_000 - 1000);
    const past = new Date(t0Unix * 1000 + 168 * 3600_000 + 1000);
    assert.equal(nextSessionState(session(), null, justInside, 168), null);
    const expired = nextSessionState(session(), null, past, 168);
    assert.equal(expired?.status, 'expired');
    assert.match(expired?.note ?? '', /Unresolved/);
  });

  test('money already seen at Stripe never expires', () => {
    const past = new Date(t0Unix * 1000 + 999 * 3600_000);
    assert.equal(nextSessionState(session({ status: 'pending_at_stripe', matched_ref: 'tu_1' }), null, past, 168), null);
  });
});

/* ── 3. Funding details: admin-only, not leaked, audited ──────────────────── */

describe('Stripe funding bank details are platform-admin only and never leak', () => {
  const details = read('supabase/functions/wallet-funding-details/index.ts');
  const detailsCode = code(details);

  test('the admin check happens before the details table is ever read', () => {
    const adminAt = detailsCode.indexOf("if (!isAdmin) return json({ error: 'Admin only' }, 403);");
    const readAt = detailsCode.indexOf(".from('wallet_funding_bank_details')");
    assert.ok(adminAt > 0 && readAt > adminAt, 'admin gate must precede the first read of the details');
  });

  test('the gateway also requires a JWT (config.toml verify_jwt = true) for both new functions', () => {
    const toml = read('supabase/config.toml');
    assert.match(toml, /\[functions\.wallet-funding-details\]\s*\nverify_jwt = true/);
    assert.match(toml, /\[functions\.wallet-liquidity-funding-session\]\s*\nverify_jwt = true/);
  });

  test('the details are never logged: no console call in the function mentions or interpolates them', () => {
    const logs = detailsCode.match(/console\.[a-z]+\([^;]*\);/g) ?? [];
    assert.ok(logs.length >= 3);
    for (const l of logs) {
      // Strip the leading '[label]' string, then only an error code / name may remain.
      const args = l.replace(/^console\.[a-z]+\(\s*'[^']*'\s*,?\s*/, '').replace(/\);$/, '');
      assert.match(args, /^(auditErr\.code|saveErr\.code|err instanceof Error \? err\.name : 'error')$/, `leaky log: ${l}`);
    }
  });

  test('responses are marked no-store', () => {
    assert.match(detailsCode, /'Cache-Control': 'no-store'/);
  });

  test('an edit is audited BEFORE it is saved, and the audit stores fields + last four digits — never the values', () => {
    const auditAt = detailsCode.indexOf(".from('wallet_funding_bank_details_audit')");
    const saveAt = detailsCode.indexOf('.upsert(');
    assert.ok(auditAt > 0 && saveAt > auditAt);
    const auditCall = detailsCode.slice(auditAt, detailsCode.indexOf('if (auditErr)'));
    assert.match(auditCall, /changed_fields: changed/);
    assert.match(auditCall, /account_number_last4: accountNumber\.slice\(-4\)/);
    assert.doesNotMatch(auditCall, /sort_code|beneficiary|instructions/);
    assert.match(detailsCode, /if \(auditErr\)[\s\S]{0,200}return json/, 'a failed audit write must block the save');
  });

  test('input is validated: 8-digit account number, 6-digit sort code, bounded text', () => {
    assert.match(detailsCode, /\^\[0-9\]\{8\}\$/);
    assert.match(detailsCode, /\^\[0-9\]\{6\}\$/);
    assert.match(detailsCode, /600/);
  });

  test('the details table is referenced only by wallet-funding-details — no other function, no client', () => {
    const hits: string[] = [];
    const walk = (dir: string, root: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.next' || name === '.git') continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { walk(full, root); continue; }
        if (!/\.(ts|tsx|js|jsx)$/.test(name) || /\.test\./.test(name)) continue;
        if (/wallet_funding_bank_details/.test(readFileSync(full, 'utf8'))) hits.push(full.replace(root, ''));
      }
    };
    walk(join(REPO_ROOT, 'supabase/functions'), REPO_ROOT);
    for (const d of ['app', 'components', 'lib']) { try { walk(join(WEB_ROOT, d), WEB_ROOT); } catch { /* absent */ } }
    for (const d of ['app', 'lib', 'components']) { try { walk(join(REPO_ROOT, d), REPO_ROOT); } catch { /* absent */ } }
    assert.deepEqual(hits.sort(), ['/supabase/functions/wallet-funding-details/index.ts']);
  });

  test('the liquidity snapshot payload carries sessions but NEVER the bank details', () => {
    const snap = code(read('supabase/functions/wallet-liquidity-snapshot/index.ts'));
    assert.doesNotMatch(snap, /wallet_funding_bank_details|wallet-funding-details|account_number|sort_code|beneficiary/);
    assert.match(snap, /funding_sessions: fundingSessions/);
    const sessions = code(read('supabase/functions/_shared/wallet-funding-sessions.ts'));
    assert.doesNotMatch(sessions, /account_number|sort_code|beneficiary/);
  });

  test('the panel fetches details on demand, holds them in component state only — no console, storage, analytics or URL use', () => {
    const panel = code(readWeb('components/admin/WalletLiquidityPanel.tsx'));
    assert.doesNotMatch(panel, /console\.|localStorage|sessionStorage|analytics|track\(|posthog|gtag|searchParams|router\.(push|replace)/i);
    assert.match(panel, /invokeAdmin<[^>]*>\("wallet-funding-details"/);
    assert.doesNotMatch(panel, /from\(["']wallet_funding_bank_details/);
  });

  test('live: all three new tables are RLS-on with no policies and no anon/authenticated privileges', () => {
    const tables = ['wallet_funding_bank_details', 'wallet_funding_bank_details_audit', 'wallet_liquidity_funding_sessions'];
    for (const t of tables) {
      const [rls] = sql(`select relrowsecurity as on from pg_class where oid = 'public.${t}'::regclass;`);
      assert.equal(rls.on, true, `${t} must have RLS enabled`);
      const [g] = sql(`select has_table_privilege('anon','public.${t}','select') as a, has_table_privilege('authenticated','public.${t}','select') as u, has_table_privilege('authenticated','public.${t}','insert') as i;`);
      assert.deepEqual([g.a, g.u, g.i], [false, false, false], `${t} must be unreachable by anon/authenticated`);
    }
    const [p] = sql(`select count(*)::int as n from pg_policies where schemaname='public' and tablename in ('wallet_funding_bank_details','wallet_funding_bank_details_audit','wallet_liquidity_funding_sessions');`);
    assert.equal(p.n, 0);
  });
});

/* ── 4. A funding session moves no money ──────────────────────────────────── */

describe('a funding session records intent only: no Stripe write, no Topup, no customer Wallet access', () => {
  const sessionFn = code(read('supabase/functions/wallet-liquidity-funding-session/index.ts'));
  const sessions = code(read('supabase/functions/_shared/wallet-funding-sessions.ts'));

  test('the session function makes no outbound HTTP call at all and never mentions Topups or Stripe writes', () => {
    assert.doesNotMatch(sessionFn, /fetch\(/);
    assert.doesNotMatch(sessionFn, /api\.stripe\.com|topups|STRIPE_SECRET_KEY|Idempotency-Key|method: 'POST'/);
  });

  test('neither the session function nor the reconciler touches a customer Wallet balance, ledger or debit/credit primitive', () => {
    for (const src of [sessionFn, sessions]) {
      assert.doesNotMatch(src, /local_wallet_balances|local_wallet_transactions|wallet_debit_with_ledger|wallet_credit_with_ledger|debitAndTransfer|executeWalletPayment|wallet_liquidity_reserve|wallet_liquidity_release/);
    }
  });

  test('the reconciler only ever GETs from Stripe — never a POST/DELETE, and only the topups / balance_transactions endpoints', () => {
    assert.doesNotMatch(sessions, /method: 'POST'|method: 'DELETE'|method: 'PUT'|URLSearchParams|body:/);
    const paths = sessions.match(/stripeGet\(`[^`]+`\)/g) ?? [];
    assert.ok(paths.length >= 3);
    for (const p of paths) assert.match(p, /\/topups\?|\/balance_transactions\?/);
  });

  test('the reconciler does nothing (and calls Stripe not at all) when no session is open', () => {
    const earlyReturn = sessions.indexOf('if (open.length === 0) return result;');
    const firstStripe = sessions.indexOf('stripeGet(`/topups');
    assert.ok(earlyReturn > 0 && firstStripe > earlyReturn);
  });

  test('the reconciler never throws and never changes anything when Stripe could not be read', () => {
    assert.match(sessions, /if \(!topups && !bts && !adjustments\) return result;/);
    assert.match(sessions, /\} catch \(e\) \{[\s\S]*?\}\s*return result;/);
  });

  test('admin check precedes any write; amount is bounded; baseline comes from the live snapshot, not the client', () => {
    const adminAt = sessionFn.indexOf("if (!isAdmin) return json({ error: 'Admin only' }, 403);");
    const insertAt = sessionFn.indexOf(".insert({");
    assert.ok(adminAt > 0 && insertAt > adminAt);
    assert.match(sessionFn, /MIN_PENCE = 1_000/);
    assert.match(sessionFn, /MAX_PENCE = 1_000_000/);
    assert.match(sessionFn, /baseline_available_pence: snap\.available_pence/);
    assert.match(sessionFn, /getWalletLiquiditySnapshot\(svc\)/);
    assert.doesNotMatch(sessionFn, /body\.baseline|body\.available/);
  });

  test('a session records the required fields', () => {
    for (const f of ['requested_amount_pence', 'target_available_pence', 'baseline_available_pence', 'initiated_by: user.id', "status: 'awaiting_funds'"]) {
      assert.ok(sessionFn.includes(f), `missing ${f}`);
    }
  });

  test('duplicate submission returns the existing session; a second open session is refused; only awaiting sessions can be cancelled', () => {
    assert.match(sessionFn, /insertErr\.code === '23505'/);
    assert.match(sessionFn, /replay: true/);
    assert.match(sessionFn, /already being tracked/);
    assert.match(sessionFn, /\.eq\('status', 'awaiting_funds'\)/);
  });

  test('live: a session row alters no customer Wallet balance; duplicate id and a second open session are rejected by the database', () => {
    const open = sql(`select count(*)::int as n from public.wallet_liquidity_funding_sessions where status in ('awaiting_funds','pending_at_stripe');`);
    if (Number(open[0].n) !== 0) { console.log('SKIP live session checks: a real funding session is open'); return; }
    const sumBefore = sql(`select coalesce(sum(balance_pence),0)::text as s, count(*)::text as c from public.local_wallet_balances;`)[0];

    const ins = (crid: string, extra = '') => `insert into public.wallet_liquidity_funding_sessions
      (client_request_id, requested_amount_pence, target_available_pence, baseline_available_pence, baseline_pending_pence, reserve_target_pence, desired_headroom_pence, initiated_by ${extra ? ', ' + extra.split('=')[0] : ''})
      values ('${TEST_PREFIX}${crid}', 14507, 15000, 493, 0, 10000, 5000, '${TEST_USER}' ${extra ? ', ' + extra.split('=')[1] : ''});`;

    sql(ins('a'));
    assert.throws(() => sql(ins('a')), /duplicate key|unique/i, 'same client_request_id must be rejected');
    assert.throws(() => sql(ins('b')), /duplicate key|unique/i, 'a second OPEN session must be rejected');
    sql(`update public.wallet_liquidity_funding_sessions set status = 'available' where client_request_id = '${TEST_PREFIX}a';`);
    sql(ins('b'));
    const [n] = sql(`select count(*)::int as n from public.wallet_liquidity_funding_sessions where client_request_id like '${TEST_PREFIX}%';`);
    assert.equal(n.n, 2);

    const sumAfter = sql(`select coalesce(sum(balance_pence),0)::text as s, count(*)::text as c from public.local_wallet_balances;`)[0];
    assert.deepEqual(sumAfter, sumBefore, 'customer Wallet balances must be unchanged');
  });

  test('live: one Stripe object cannot satisfy two sessions (matched_ref unique)', () => {
    const open = sql(`select count(*)::int as n from public.wallet_liquidity_funding_sessions where status in ('awaiting_funds','pending_at_stripe') and client_request_id not like '${TEST_PREFIX}%';`);
    if (Number(open[0].n) !== 0) return;
    sql(`update public.wallet_liquidity_funding_sessions set matched_ref = 'tu_test_push_funding_dup' where client_request_id = '${TEST_PREFIX}a';`);
    assert.throws(
      () => sql(`update public.wallet_liquidity_funding_sessions set status = 'available', matched_ref = 'tu_test_push_funding_dup' where client_request_id = '${TEST_PREFIX}b';`),
      /duplicate key|unique/i,
    );
  });

  after(() => {
    try { sql(`delete from public.wallet_liquidity_funding_sessions where client_request_id like '${TEST_PREFIX}%';`); } catch { /* best effort */ }
  });
});

/* ── 5. Recommended amount is live, never hard-coded ──────────────────────── */

describe('the recommended transfer is computed from the live snapshot, never hard-coded', () => {
  test('formula: reserve + desired headroom − available, floored at 0', () => {
    const rec = (reserve: number, headroom: number, available: number) => Math.max(0, reserve + headroom - available);
    assert.equal(rec(10000, 5000, 493), 14507);
    assert.equal(rec(10000, 5000, 555), 14445);
    assert.equal(rec(10000, 5000, 20000), 0);
  });

  test('the shared snapshot computes it; the panel only displays snapshot.recommended_funding_pence', () => {
    const wl = code(read('supabase/functions/_shared/wallet-liquidity.ts'));
    assert.match(wl, /Math\.max\(0, reserve_pence \+ desired_headroom_pence - available_pence\)/);
    const panel = code(readWeb('components/admin/WalletLiquidityPanel.tsx'));
    assert.match(panel, /const recommended = snapshot\.recommended_funding_pence;/);
  });

  test('no funding amount (145 / 150 / 14507 / 15000 …) is hard-coded in the panel, the session function or the reconciler', () => {
    const panel = code(readWeb('components/admin/WalletLiquidityPanel.tsx'));
    const srcs = [panel, code(read('supabase/functions/wallet-liquidity-funding-session/index.ts')), code(read('supabase/functions/_shared/wallet-funding-sessions.ts'))];
    for (const s of srcs) assert.doesNotMatch(s, /\b(14[0-9]{3}|15000|145(\.\d\d)?|150(\.00)?)\b/);
  });
});

/* ── 6. Admin UX ──────────────────────────────────────────────────────────── */

describe('the Admin funding experience', () => {
  const raw = readWeb('components/admin/WalletLiquidityPanel.tsx');
  const panel = code(raw);

  test('before a session: shows recommended amount, target, available, reserve, headroom and status', () => {
    const v = view(panel, 'StartSessionView');
    for (const s of ['Recommended transfer', 'Target available balance', 'Current available', 'Reserve', 'Desired headroom', 'Wallet status']) {
      assert.ok(v.includes(s), `missing ${s}`);
    }
  });

  test('the active session offers copy buttons for amount, account number, sort code and beneficiary', () => {
    assert.ok(view(panel, 'ActiveSessionView').includes('Copy amount'));
    for (const s of ['Copy beneficiary', 'Copy account number', 'Copy sort code']) assert.ok(panel.includes(s), `missing ${s}`);
    assert.match(panel, /\{copyable && <CopyButton label=\{copyLabel\}/);
  });

  test('state copy: awaiting / received-pending / funded', () => {
    assert.match(panel, /funding transfer awaiting Stripe/);
    assert.match(panel, /Received by Stripe — pending availability/);
    assert.match(panel, /Reserve funded/);
    assert.match(panel, /Spendable headroom: \{gbp\(snapshot\.headroom_pence\)\}/);
    assert.match(panel, /Wallet status: \{STATUS_STYLE\[snapshot\.status\]\.label\}/);
  });

  test('"Reserve funded" is shown only for an available session — a pending one is not presented as spendable', () => {
    const banner = panel.slice(panel.indexOf('function SessionBanner'), panel.indexOf('function MiniStat'));
    const pendingAt = banner.indexOf('pending_at_stripe');
    const fundedAt = banner.indexOf('Reserve funded');
    assert.ok(pendingAt > 0 && fundedAt > pendingAt);
    assert.match(banner, /session\.status === "available" && !open/);
  });

  test('View in Stripe is a secondary troubleshooting link only', () => {
    assert.match(panel, /For troubleshooting only:/);
    assert.match(panel, /View in Stripe/);
    assert.doesNotMatch(raw, /Open Stripe Dashboard/);
  });

  test('programmatic funding stays behind its flag: wallet-liquidity-fund is intact and funding_enabled is false', () => {
    const fund = code(read('supabase/functions/wallet-liquidity-fund/index.ts'));
    assert.match(fund, /wallet\.liquidity\.funding_enabled/);
    assert.match(fund, /!== 'true'/);
    const [row] = sql(`select value from public.admin_config where key = 'wallet.liquidity.funding_enabled';`);
    assert.equal(row.value, 'false');
    assert.match(panel, /snapshot\.funding_enabled \? \(/);
  });
});

/* ── 6b. ORDER: session created → bank transfer sent → Stripe arrival reconciled ─────── */

describe('the funding order is unambiguous: the session exists BEFORE any instruction to send money', () => {
  const panel = code(readWeb('components/admin/WalletLiquidityPanel.tsx'));
  const raw = readWeb('components/admin/WalletLiquidityPanel.tsx');
  const before = view(panel, 'StartSessionView');
  const after = view(panel, 'ActiveSessionView');

  test('PushFunding renders the start view when there is no open session, the active view when there is one', () => {
    const pf = view(panel, 'PushFunding');
    assert.match(pf, /\{open \? \(\s*<ActiveSessionView[\s\S]*?\) : \(\s*<StartSessionView/);
  });

  test('before the session: no "send" instruction of any kind, no copy buttons, and an explicit "do not send yet"', () => {
    assert.doesNotMatch(before, /Now send|send exactly|FPS or BACS|Copy amount|<CopyButton/);
    assert.match(before, /Do not send any money yet/);
    assert.match(before, /Create the funding\s+instructions first/);
    assert.match(before, /<FundingDetailsBlock copyable=\{false\}/, 'details may be reviewed but not copied before a session exists');
  });

  test('the start action is "Create funding instructions" and its confirmation says nothing is moved', () => {
    assert.match(before, /Create funding instructions/);
    assert.match(before, /This does not move any money\. OneShetland will record the amount you intend to send and then show you the bank details to use\./);
    assert.doesNotMatch(raw, /I'm sending this transfer/);
  });

  test('the start button is disabled until the bank details are configured', () => {
    assert.match(before, /detailsConfigured === false/);
    assert.match(before, /onConfiguredChange=\{setDetailsConfigured\}/);
  });

  test('after the session: "Now send exactly £X … using FPS or BACS" is shown, with the exact amount and copy buttons', () => {
    assert.match(after, /Now send exactly \{gbp\(session\.requested_amount_pence\)\} from the OneShetland business bank using FPS or BACS\./);
    assert.match(after, /<CopyButton label="Copy amount"/);
    assert.match(after, /<FundingDetailsBlock copyable canEdit=\{false\} \/>/);
  });

  test('the send instruction appears ONLY in the awaiting_funds branch of the active view — never once Stripe has the money', () => {
    const awaitingAt = after.indexOf('session.status === "awaiting_funds"');
    const sendAt = after.indexOf('Now send exactly');
    const elseAt = after.indexOf(') : (', awaitingAt);
    const receivedAt = after.indexOf('Do not send it');
    assert.ok(awaitingAt >= 0 && sendAt > awaitingAt && sendAt < elseAt && receivedAt > elseAt);
    assert.doesNotMatch(after.slice(elseAt), /Now send|<CopyButton|FundingDetailsBlock/);
  });

  test('an open session shows ITS OWN frozen amount, never a freshly recalculated recommendation', () => {
    assert.match(after, /Exact amount to send/);
    assert.match(after, /gbp\(session\.requested_amount_pence\)/);
    assert.match(after, /gbp\(session\.target_available_pence\)/);
    assert.doesNotMatch(after, /recommended_funding_pence|recommended\b/);
  });

  test('bank details cannot be edited while a session is open (frozen), but can before one', () => {
    assert.match(after, /canEdit=\{false\}/);
    assert.match(before, /<FundingDetailsBlock copyable=\{false\} canEdit /);
    assert.match(panel, /\{canEdit && <button onClick=\{startEdit\}/);
  });

  test('server side: the session is created (INSERT) before anything can be matched, and reconciliation reads only a session that already exists', () => {
    const fn = code(read('supabase/functions/wallet-liquidity-funding-session/index.ts'));
    assert.match(fn, /status: 'awaiting_funds'/);
    const rec = code(read('supabase/functions/_shared/wallet-funding-sessions.ts'));
    assert.match(rec, /\.from\('wallet_liquidity_funding_sessions'\)\s*\.select\(SESSION_COLUMNS\)\.in\('status', OPEN_SESSION_STATUSES\)/);
    assert.ok(rec.indexOf('if (open.length === 0) return result;') < rec.indexOf('pickFundingMatch(s, candidates'));
  });
});

describe('regression: session created → bank transfer initiated → Stripe arrival reconciliation', () => {
  const sessionCreated = '2026-10-10T12:00:00.000Z';
  const created = Math.floor(new Date(sessionCreated).getTime() / 1000);
  const s = (over: Partial<MatchableSession> = {}): MatchableSession =>
    ({ status: 'awaiting_funds', requested_amount_pence: 14507, created_at: sessionCreated, matched_ref: null, ...over });

  test('the correct order reconciles: transfer sent AFTER the session → Stripe credit AFTER the session → pending then available', () => {
    const sentAt = created + 600; // operator follows "Now send exactly £X"
    const arrived = candidateFromTopup({ id: 'tu_ok', amount: 14507, currency: 'gbp', created: sentAt + 3600, status: 'pending' })!;
    const m1 = pickFundingMatch(s(), [arrived], new Set());
    assert.equal(m1?.ref, 'tu_ok');
    assert.equal(nextSessionState(s(), m1, new Date((sentAt + 3700) * 1000), 168)?.status, 'pending_at_stripe');
    const settled = candidateFromTopup({ id: 'tu_ok', amount: 14507, currency: 'gbp', created: sentAt + 3600, status: 'succeeded' })!;
    const open = s({ status: 'pending_at_stripe', matched_ref: 'tu_ok' });
    assert.equal(nextSessionState(open, pickFundingMatch(open, [settled], new Set()), new Date((sentAt + 7200) * 1000), 168)?.status, 'available');
  });

  test('the WRONG order is exactly what the UI now prevents: money that reached Stripe before the session was started is not recognised', () => {
    const sentTooEarly = candidateFromTopup({ id: 'tu_early', amount: 14507, currency: 'gbp', created: created - 3600, status: 'succeeded' })!;
    assert.equal(pickFundingMatch(s(), [sentTooEarly], new Set()), null);
    assert.equal(nextSessionState(s(), null, new Date((created + 60) * 1000), 168), null, 'session stays awaiting_funds');
  });

  test('the matching rules themselves are unchanged (slack, exact amount, claim-once)', () => {
    assert.equal(CLOCK_SLACK_SECONDS, 120);
    const src = code(read('supabase/functions/_shared/wallet-funding-match.ts'));
    assert.match(src, /c\.amount_pence !== session\.requested_amount_pence/);
    assert.match(src, /c\.created_unix >= sessionUnix - CLOCK_SLACK_SECONDS/);
    assert.match(src, /claimedByOthers\.has\(c\.ref\)/);
  });
});

/* ── 6c. Copy: the action creates INSTRUCTIONS; it does not sound like a bank pull ─────── */

describe('copy: the button creates funding instructions and never reads as OneShetland pulling money', () => {
  const raw = readWeb('components/admin/WalletLiquidityPanel.tsx');
  const panel = code(raw);
  const before = view(panel, 'StartSessionView');
  const after = view(panel, 'ActiveSessionView');

  test('before a session: button, confirmation title, body and confirm label use the agreed wording exactly', () => {
    assert.match(before, /\{busy \? "Creating…" : "Create funding instructions"\}/);
    assert.match(before, /title: "Create funding instructions\?"/);
    assert.match(before, /body: "This does not move any money\. OneShetland will record the amount you intend to send and then show you the bank details to use\."/);
    assert.match(before, /confirmLabel: "Create instructions"/);
  });

  test('after a session: heading, primary message and supporting text use the agreed wording exactly', () => {
    assert.match(after, />Funding instructions ready</);
    assert.match(after, /Now send exactly \{gbp\(session\.requested_amount_pence\)\} from the OneShetland business bank using FPS or BACS\./);
    assert.match(after, /OneShetland will watch Stripe and update this page when the funds arrive\./);
  });

  test('the primary message comes after the heading, and the supporting text after the primary message', () => {
    const h = after.indexOf('Funding instructions ready');
    const p = after.indexOf('Now send exactly');
    const sup = after.indexOf('OneShetland will watch Stripe');
    assert.ok(h >= 0 && p > h && sup > p);
  });

  test('the "start" wording that sounds like a bank pull is gone from the whole panel (button, dialogs, stats, history)', () => {
    assert.doesNotMatch(raw, /Start funding transfer|Start the funding transfer|Transfer started|Available when started|FPS\/BACS/);
    // "Starting…" legitimately remains on the dormant programmatic Topup button; it must not appear in the push-funding views.
    assert.doesNotMatch(view(panel, 'PushFunding') + before + after, /Starting…/);
    assert.doesNotMatch(raw, /Cancel this funding transfer|Cancel funding transfer/);
  });

  test('the "Create…" wording appears only in the pre-session view; the heading and send message only after a session', () => {
    assert.doesNotMatch(after, /Create funding instructions|Create instructions/);
    assert.doesNotMatch(before, /Funding instructions ready|Now send exactly/);
  });

  test('the active view keeps the frozen amount, session time, bank details, copy buttons and the awaiting / pending / available states', () => {
    assert.match(after, /Exact amount to send/);
    assert.match(after, /<MiniStat label="Instructions created" value=\{new Date\(session\.created_at\)/);
    assert.match(after, /<FundingDetailsBlock copyable canEdit=\{false\} \/>/);
    assert.match(after, /<CopyButton label="Copy amount"/);
    const banner = view(panel, 'SessionBanner');
    assert.match(banner, /funding transfer awaiting Stripe/);
    assert.match(banner, /Received by Stripe — pending availability/);
    assert.match(banner, /Reserve funded/);
  });

  test('cancelling is worded as cancelling the instructions, and only offered before any money is seen', () => {
    assert.match(after, /title: "Cancel these funding instructions\?"/);
    assert.match(after, /confirmLabel: "Cancel instructions"/);
    assert.match(after, /I haven't sent it — cancel these funding instructions/);
  });

  test('copy-only change: the request ids and server calls are untouched', () => {
    assert.match(before, /invokeAdmin\("wallet-liquidity-funding-session", \{\s*action: "start", requested_amount_pence: amountPence, client_request_id: requestId,/);
    assert.match(after, /action: "cancel", session_id: session\.id/);
  });
});

/* ── 7. Monitor + preflight ───────────────────────────────────────────────── */

describe('arrival is detected unattended, and the Wallet-spend preflight is untouched', () => {
  test('the scheduled monitor reconciles open funding sessions after reading the snapshot', () => {
    const mon = code(read('supabase/functions/wallet-liquidity-monitor/index.ts'));
    assert.match(mon, /import \{ reconcileFundingSessions \}/);
    assert.ok(mon.indexOf('getWalletLiquiditySnapshot(svc)') < mon.indexOf('reconcileFundingSessions(svc)'));
    assert.match(mon, /requireCronSecret/);
  });

  test('the snapshot reconciles BEFORE listing sessions, so the panel is never stale', () => {
    const snap = code(read('supabase/functions/wallet-liquidity-snapshot/index.ts'));
    assert.match(snap, /reconcileFundingSessions\(svc\)\.then\(\(\) => getRecentFundingSessions\(svc\)\)/);
  });

  test('pending funds are never counted as available: available_pence still comes only from Stripe\'s live balance', () => {
    const wl = code(read('supabase/functions/_shared/wallet-liquidity.ts'));
    assert.doesNotMatch(wl, /wallet_liquidity_funding_sessions|wallet-funding-sessions|funding_sessions/);
    assert.match(wl, /\/v1\/balance/);
  });

  test('the preflight (wallet-pay.ts) and its reservation RPCs do not reference the push-funding workflow at all', () => {
    const wp = code(read('supabase/functions/_shared/wallet-pay.ts'));
    assert.doesNotMatch(wp, /funding_session|wallet-funding|wallet_funding|wallet_liquidity_funding/);
    const snapshotAt = wp.indexOf('getWalletLiquiditySnapshot(svc)');
    const reserveAt = wp.indexOf('reserveWalletLiquidity(svc,');
    const debitAt = wp.indexOf('await debitAndTransfer(svc,');
    assert.ok(snapshotAt > 0 && reserveAt > snapshotAt && reserveAt < debitAt);
    assert.match(wp, /reason: 'liquidity_unavailable'/);
  });

  test('live: the reservation RPC is unchanged', () => {
    const [row] = sql(`select pg_get_functiondef('public.wallet_liquidity_reserve'::regproc) as d;`);
    assert.match(String(row.d), /pg_advisory_xact_lock\(hashtext\('wallet_liquidity_reserve'\)\)/);
  });

  test('live: the expiry config exists', () => {
    const [row] = sql(`select value from public.admin_config where key = 'wallet.liquidity.funding_session_expiry_hours';`);
    assert.equal(row.value, '168');
  });
});
