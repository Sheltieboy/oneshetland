/**
 * wallet-tier-entitlement.node.test.ts — taking Wallet payments is Pro; the
 * money in a customer's wallet is theirs.
 *
 * Fourth and last paid capability, and the one where the two halves have to be
 * held apart hardest. local_wallet_balances is keyed on user_id alone: a
 * balance is platform-wide, no business owns any of it, and cashback becomes
 * ordinary balance the instant it is credited. So a lapsing subscription must
 * stop a business RECEIVING a payment and must not reach customer money at all.
 *
 * Two enforcement points, not five. Activation, and the one executor both
 * payment routes converge on — Counter, Till and NFC inherit it.
 *
 * Cashback configuration is deliberately NOT tier-gated: it is setup, and it
 * can only ever be earned inside a payment the executor now refuses.
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
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB, p), 'utf8');

const PAY     = read('supabase/functions/_shared/wallet-pay.ts');
const LEDGER  = read('supabase/functions/_shared/wallet-ledger.ts');
const REFUND  = read('supabase/functions/refund-payment/index.ts');
const TOPUP   = read('supabase/functions/local-wallet-topup-intent/index.ts');

function sql(body: string): Record<string, unknown>[] {
  const out = execFileSync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 });
  const parsed = JSON.parse(out.slice(out.indexOf('{'))) as { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 400));
  return parsed.rows ?? [];
}

const OWNER = 'f3f30001-1111-1111-1111-111111111111';
const CUST  = 'f3f30009-9999-9999-9999-999999999999';
const B = {
  pro:      'f3f30002-2222-2222-2222-222222222222',
  free:     'f3f30003-3333-3333-3333-333333333333',
  premium:  'f3f30004-4444-4444-4444-444444444444',
  lapsing:  'f3f30005-5555-5555-5555-555555555555',
  premNull: 'f3f30006-6666-6666-6666-666666666666',
};

const FIXTURE = `
begin;
  insert into auth.users (id,email) values ('${OWNER}','wl-o@probe.invalid'),('${CUST}','wl-c@probe.invalid');
  insert into public.local_businesses (id,owner_id,name,category,address,is_active) values
    ('${B.pro}','${OWNER}','WL PRO','other','P',true),
    ('${B.free}','${OWNER}','WL FREE','other','P',true),
    ('${B.premium}','${OWNER}','WL PREM','other','P',true),
    ('${B.lapsing}','${OWNER}','WL LAPSING','other','P',true),
    ('${B.premNull}','${OWNER}','WL NULL','other','P',true);
  update public.local_businesses set subscription_tier='pro', subscription_until=now()+interval '10 days'
    where id in ('${B.pro}','${B.lapsing}');
  update public.local_businesses set subscription_tier='premium', subscription_until=now()+interval '10 days' where id='${B.premium}';
  update public.local_businesses set subscription_tier='premium', subscription_until=null where id='${B.premNull}';
  update public.local_businesses set accepts_wallet=true where id='${B.lapsing}';
  -- a customer with real value, and a completed spend to reverse later
  insert into public.local_wallet_balances (user_id, balance_pence) values ('${CUST}', 5000);
  create temp table r(step text, outcome text) on commit drop;
  grant insert, select on r to authenticated, anon;
`;
const asOwnerRole = `reset role; select set_config('request.jwt.claims','',true);`;
const asUser = (id: string) => `
  reset role;
  select set_config('request.jwt.claims','{"sub":"${id}","role":"authenticated"}',true);
  set local role authenticated;`;
const acceptAll = Object.values(B).map((id) =>
  `select public.record_commercial_terms_acceptance('${id}'::uuid);`).join('\n');
const attempt = (step: string, stmt: string) => `
do $p$ begin ${stmt};
  insert into r values ('${step}','ALLOWED');
exception when others then insert into r values ('${step}','refused'); end $p$;`;
const END = `reset role; select * from r order by step; rollback;`;
const outcome = (rows: Record<string, unknown>[], step: string) =>
  rows.find((r) => r.step === step)?.outcome;
const lapse = `update public.local_businesses set subscription_until=now()-interval '1 hour' where id='${B.lapsing}';`;

/* ── 1. Turning Wallet on ───────────────────────────────────────────────── */

describe('accepting Wallet payments needs Pro', () => {
  const rows = sql(FIXTURE + asUser(OWNER) + acceptAll +
    attempt('pro',          `update public.local_businesses set accepts_wallet=true where id='${B.pro}'`) +
    attempt('premium',      `update public.local_businesses set accepts_wallet=true where id='${B.premium}'`) +
    attempt('free',         `update public.local_businesses set accepts_wallet=true where id='${B.free}'`) +
    attempt('null expiry',  `update public.local_businesses set accepts_wallet=true where id='${B.premNull}'`) +
    asOwnerRole + lapse + asUser(OWNER) +
    attempt('lapsed turns it off', `update public.local_businesses set accepts_wallet=false where id='${B.lapsing}'`) +
    attempt('lapsed turns it back on', `update public.local_businesses set accepts_wallet=true where id='${B.lapsing}'`) +
    attempt('directory edit while lapsed', `update public.local_businesses set description='d' where id='${B.lapsing}'`) +
    END);

  test('Pro may', () => assert.equal(outcome(rows, 'pro'), 'ALLOWED'));
  test('Premium may — it meets Pro', () => assert.equal(outcome(rows, 'premium'), 'ALLOWED'));
  test('Free may not', () => assert.equal(outcome(rows, 'free'), 'refused'));
  test('a paid tier with no end date may not', () => assert.equal(outcome(rows, 'null expiry'), 'refused'));

  test('a lapsed business may always turn it OFF', () => {
    assert.equal(outcome(rows, 'lapsed turns it off'), 'ALLOWED',
      'never trap a business with Wallet exposure');
  });

  test('but may not turn it back on', () => {
    assert.equal(outcome(rows, 'lapsed turns it back on'), 'refused');
  });

  test('an unrelated Directory edit is never examined', () => {
    assert.equal(outcome(rows, 'directory edit while lapsed'), 'ALLOWED');
  });

  test('turning it off needs no current terms either', () => {
    const solo = sql(FIXTURE + asUser(OWNER) +
      attempt('off without terms', `update public.local_businesses set accepts_wallet=false where id='${B.lapsing}'`) + END);
    assert.equal(outcome(solo, 'off without terms'), 'ALLOWED');
  });

  test('terms are still required to turn it on — tier did not replace W3I', () => {
    const solo = sql(FIXTURE + asUser(OWNER) +
      attempt('on without terms', `update public.local_businesses set accepts_wallet=true where id='${B.pro}'`) + END);
    assert.equal(outcome(solo, 'on without terms'), 'refused');
  });
});

/* ── 2. Cashback is setup, not activation ──────────────────────────────── */

describe('cashback configuration is deliberately NOT tier-gated', () => {
  const rows = sql(FIXTURE + asUser(OWNER) + acceptAll +
    attempt('free sets cashback', `update public.local_businesses set cashback_percent=5 where id='${B.free}'`) +
    asOwnerRole + lapse + asUser(OWNER) +
    attempt('lapsed sets cashback', `update public.local_businesses set cashback_percent=3 where id='${B.lapsing}'`) +
    attempt('lapsed reduces cashback', `update public.local_businesses set cashback_percent=0 where id='${B.lapsing}'`) +
    END);

  test('a Free business may configure a cashback rate', () => {
    assert.equal(outcome(rows, 'free sets cashback'), 'ALLOWED',
      'setup is allowed below tier; going live is not');
  });

  test('a lapsed business may change its rate in either direction', () => {
    assert.equal(outcome(rows, 'lapsed sets cashback'), 'ALLOWED');
    assert.equal(outcome(rows, 'lapsed reduces cashback'), 'ALLOWED');
  });

  test('the guard never branches on cashback_percent', () => {
    // The word appears once, in a comment saying exactly this. What must not
    // exist is a READ of the column: a tier check there would break
    // setup-before-upgrade.
    const [row] = sql(`select pg_get_functiondef('public.local_businesses_wallet_tier_guard'::regproc) as d;`);
    const def = String(row.d);
    assert.ok(!/(new|old)\.cashback_percent/.test(def), 'the guard must not read cashback_percent');
    assert.ok(!/cashback[^\n]*business_meets_tier|business_meets_tier[^\n]*cashback/.test(def));
  });

  test('so no cashback can be earned anyway — it lives inside the payment', () => {
    // Belt and braces: the executor refuses before the debit that credits it.
    const check = PAY.indexOf("p_required_tier: 'pro'");
    const cashbackCalc = PAY.indexOf('const cashbackPence =');
    assert.ok(check < cashbackCalc, 'refused before cashback is even computed');
  });
});

/* ── 3. The shared payment executor ─────────────────────────────────────── */

describe('one money boundary, both routes', () => {
  test('the check precedes every financial step', () => {
    const check = PAY.indexOf("p_required_tier: 'pro'");
    assert.ok(check > 0, 'the executor must ask');
    assert.ok(check < PAY.indexOf('const cashbackPence ='), 'before cashback');
    assert.ok(check < PAY.indexOf('debitAndTransfer('), 'before the debit and transfer');
  });

  test('the debit and the Stripe transfer both live behind it', () => {
    assert.match(LEDGER, /wallet_debit_with_ledger/);
    assert.match(LEDGER, /api\.stripe\.com/);
    assert.match(PAY, /debitAndTransfer\(/);
  });

  test('it uses the server predicate, not a second expiry formula', () => {
    assert.match(PAY, /rpc\('business_meets_tier'/);
    assert.ok(!/subscription_until|subscription_tier/.test(PAY));
  });

  test('an unreadable answer fails closed', () => {
    assert.match(PAY, /if \(tierErr \|\| mayTakeWallet !== true\)/);
  });

  test('both flows converge on it — no duplicate checks needed', () => {
    for (const fn of ['local-wallet-pay', 'wallet-charge-approve']) {
      const src = read(`supabase/functions/${fn}/index.ts`);
      assert.match(src, /executeWalletPayment/, `${fn} must use the shared executor`);
      assert.ok(!/business_meets_tier/.test(src),
        `${fn} must not duplicate the check — one money boundary`);
    }
  });

  test('the customer is told the business is not accepting Wallet, nothing more', () => {
    const at = PAY.indexOf("p_required_tier: 'pro'");
    const block = PAY.slice(at, at + 500);
    assert.match(block, /isn't currently accepting Wallet payments/);
    for (const leak of ['Pro', 'subscription', 'plan', 'tier', 'billing', 'expire']) {
      assert.ok(!new RegExp(`error: "[^"]*${leak}`, 'i').test(block), `must not leak: ${leak}`);
    }
  });
});

/* ── 4. Customer money is never touched ─────────────────────────────────── */

describe("a customer's wallet is not the seller's to gate", () => {
  test('nothing was put on balances, the ledger, top-up or refunds', () => {
    const [row] = sql(`
      select
        (select count(*)::int from pg_trigger t join pg_class c on c.oid=t.tgrelid
          where not t.tgisinternal and c.relname in
            ('local_wallet_balances','local_wallet_transactions','local_wallet_topup_recovery','wallet_payment_claims')
            and position('business_meets_tier' in pg_get_functiondef(t.tgfoid)) > 0) as triggers,
        (select count(*)::int from pg_policy p join pg_class c on c.oid=p.polrelid
          where c.relname in ('local_wallet_balances','local_wallet_transactions')
            and position('business_meets_tier' in
              coalesce(pg_get_expr(p.polqual,p.polrelid),'')||coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')) > 0) as policies;`);
    assert.equal(row.triggers, 0, 'a business plan must never be a condition on customer money');
    assert.equal(row.policies, 0);
  });

  test('refunds and reversals gained no tier check', () => {
    assert.ok(!/business_meets_tier/.test(REFUND), 'a lapsed business must still make customers whole');
    const [row] = sql(`
      select position('business_meets_tier' in pg_get_functiondef('public.wallet_reverse_debit'::regproc)) > 0 as gated;`);
    assert.equal(row.gated, false);
  });

  test('top-ups are independent of any business', () => {
    assert.ok(!/business_meets_tier/.test(TOPUP));
  });

  test('a customer keeps their balance when a business lapses', () => {
    const rows = sql(FIXTURE + asOwnerRole + lapse +
      `insert into r select 'balance after lapse', balance_pence::text from public.local_wallet_balances where user_id='${CUST}';` +
      END);
    assert.equal(outcome(rows, 'balance after lapse'), '5000');
  });

  test('and can still read it', () => {
    const rows = sql(FIXTURE + asOwnerRole + lapse + asUser(CUST) +
      `insert into r select 'customer reads balance', balance_pence::text from public.local_wallet_balances where user_id='${CUST}';` +
      END);
    assert.equal(outcome(rows, 'customer reads balance'), '5000');
  });
});

/* ── 5. Presentation ────────────────────────────────────────────────────── */

describe('a customer is only told what is true today', () => {
  test('wallet_live is the flag AND current Pro AND active', () => {
    const rows = sql(FIXTURE + asOwnerRole +
      `insert into r select 'live while pro', public.wallet_live(b.*)::text from public.local_businesses b where b.id='${B.lapsing}';` +
      lapse +
      `insert into r select 'live after lapse', public.wallet_live(b.*)::text from public.local_businesses b where b.id='${B.lapsing}';
       insert into r select 'flag still stored', accepts_wallet::text from public.local_businesses where id='${B.lapsing}';
       update public.local_businesses set subscription_until=now()+interval '5 days' where id='${B.lapsing}';
       insert into r select 'live after renewal', public.wallet_live(b.*)::text from public.local_businesses b where b.id='${B.lapsing}';` +
      END);
    assert.equal(outcome(rows, 'live while pro'), 'true');
    assert.equal(outcome(rows, 'live after lapse'), 'false');
    assert.equal(outcome(rows, 'flag still stored'), 'true', 'the stored intent is never auto-flipped');
    assert.equal(outcome(rows, 'live after renewal'), 'true', 'and works again on renewal');
  });

  test('it is a computed column, so a list costs one query not one per row', () => {
    const [row] = sql(`
      select pg_get_function_identity_arguments(p.oid) as args
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='wallet_live';`);
    assert.match(String(row.args), /local_businesses/,
      'taking the row type is what makes it selectable per row in one query');
  });

  test('anon may evaluate it — signed-out visitors read these surfaces', () => {
    const [row] = sql(`
      select has_function_privilege('anon','public.wallet_live(public.local_businesses)','execute') as anon;`);
    assert.equal(row.anon, true);
  });

  test('all three customer surfaces read it, and none re-derive expiry', () => {
    const surfaces: [string, string][] = [
      ['web listing',   readWeb('app/directory/[id]/page.tsx')],
      ['mobile detail', read('app/local-business-detail.tsx')],
      ['mobile browse', read('app/local-businesses-browse.tsx')],
    ];
    for (const [name, src] of surfaces) {
      assert.match(src, /wallet_live/, `${name} must use the server answer`);
      assert.ok(!/subscription_until/.test(src), `${name} must not re-derive expiry`);
    }
  });

  test('both loaders actually select it', () => {
    assert.match(readWeb('lib/local-data.ts'), /accepts_wallet, wallet_live/);
    assert.match(read('lib/local-api.ts'), /accepts_wallet, wallet_live/);
  });

  test('cashback is not advertised when Wallet is not live', () => {
    const page = readWeb('app/directory/[id]/page.tsx');
    assert.match(page, /const cashback = walletLive && b\.cashback_percent > 0/);
  });
});

/* ── 6. Bypass, and everything else left alone ──────────────────────────── */

describe('no way round, nothing else disturbed', () => {
  test('direct PostgREST activation cannot bypass — the same call a deep link makes', () => {
    const rows = sql(FIXTURE + asUser(OWNER) + acceptAll +
      attempt('direct activate', `update public.local_businesses set accepts_wallet=true where id='${B.free}'`) +
      asOwnerRole +
      `insert into r select 'flag after', accepts_wallet::text from public.local_businesses where id='${B.free}';` +
      END);
    assert.equal(outcome(rows, 'direct activate'), 'refused');
    assert.equal(outcome(rows, 'flag after'), 'false');
  });

  test('W3I is intact and was not broadened', () => {
    const [row] = sql(`
      select (select count(*)::int from pg_trigger where tgname='commercial_terms_guard' and not tgisinternal) as w3i,
             (select count(*)::int from pg_trigger where tgname='local_businesses_commercial_guard' and not tgisinternal) as lb,
             (position('business_meets_tier' in pg_get_functiondef('public.local_businesses_commercial_guard'::regproc)) > 0) as polluted,
             public.commercial_terms_version() as version;`);
    assert.equal(row.w3i, 9);
    assert.equal(row.lb, 1);
    assert.equal(row.polluted, false);
    assert.equal(row.version, '1.0');
  });

  test('Bookings, Products and Passes enforcement is exactly as deployed', () => {
    const rows = sql(`
      select tgname from pg_trigger
       where tgname in ('book_bookings_tier_guard','local_businesses_bookings_tier_guard',
                        'products_tier_guard','book_unit_items_tier_guard')
         and not tgisinternal order by tgname;`);
    assert.deepEqual(rows.map((r) => r.tgname), [
      'book_bookings_tier_guard', 'book_unit_items_tier_guard',
      'local_businesses_bookings_tier_guard', 'products_tier_guard',
    ]);
  });

  test('Offers and Loyalty gained nothing', () => {
    const rows = sql(`
      select c.relname as tbl from pg_trigger t join pg_class c on c.oid=t.tgrelid
       where not t.tgisinternal and position('business_meets_tier' in pg_get_functiondef(t.tgfoid)) > 0
       order by c.relname;`);
    assert.ok(!rows.some((r) => r.tbl === 'local_offers'), 'local_offers must not appear');
    assert.ok(!rows.some((r) => r.tbl === 'local_loyalty_programs'), 'local_loyalty_programs must not appear');
  });

  test('the ordinary Pro management gates are unchanged', () => {
    assert.match(readWeb('app/business/[id]/manage/wallet/page.tsx'),
      /tierUnlocks\(business\.subscription_tier, "wallet"\)/);
  });
});
