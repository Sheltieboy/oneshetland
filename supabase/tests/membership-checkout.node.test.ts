/**
 * membership-checkout.node.test.ts — one fee, and a total the customer sees
 * before they pay it.
 *
 * WHAT WENT WRONG IN THE REAL PURCHASE
 *
 * The hub page showed a control reading "Pay by card · £10/year". The charge
 * was £10.95. The fee was correct and nobody had shown it. There was no summary
 * step at all: the button that named a price was the button that took the
 * money.
 *
 * AND THE FEE WAS NOT ONE FEE
 *
 * The two routes read different configuration keys:
 *
 *   card    getCommissionConfig('membership') → fees.membership.fixed_pence
 *                                             → unset, code default 95p
 *   wallet  fees.hub_membership.flat_pence    → set to 50
 *
 * so the same £10 membership cost £10.95 by card and £10.50 by wallet, and
 * nobody had decided that. There is now one rail, seeded explicitly at 95p, and
 * the wallet reads it through the same helper the card uses.
 *
 * AND THE CLIENTS MIRRORED IT
 *
 * The app carried HUB_MEMBERSHIP_FEE_PENCE = 50 as a display constant, so its
 * confirm sheet showed a £10.50 total and called the fee a "Booking fee".
 * Mirrored constants drift; both clients now read membership_quote(), which
 * computes from the same tier row and the same rail as the charge.
 *
 * SAFETY
 * Source inspection plus read-only quotes against production. No payment is
 * made, no membership altered.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const web = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');

const intentFn = read('supabase/functions/create-hub-membership-intent/index.ts');
const checkoutFn = read('supabase/functions/wallet-checkout/index.ts');
const quoteMig = read('supabase/migrations/20260827090000_membership_quote.sql');
const feeMig = read('supabase/migrations/20260826230000_membership_fee_single_source.sql');
const panel = web('components/hubs/HubMembershipPanel.tsx');
const checkout = web('components/hubs/MembershipCheckout.tsx');
const hubPage = web('app/hubs/[id]/page.tsx');
const webCard = web('components/hubs/MembershipCard.tsx');
const appHub = read('app/hubs/[id].tsx');
const appApi = read('lib/hubs-api.ts');
const appCards = read('app/hub-my-memberships.tsx');

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

/* ── one fee ──────────────────────────────────────────────────────────────── */

describe('one membership fee, one place to change it', () => {
  test('the authoritative rail is seeded, not left to a code default', () => {
    const r = runSql(`select key, value from public.admin_config
                       where key in ('fees.membership.percent_bps','fees.membership.fixed_pence')
                       order by key;`);
    const cfg = Object.fromEntries(r.map((x) => [x.key, x.value]));
    assert.equal(cfg['fees.membership.fixed_pence'], '95');
    assert.equal(cfg['fees.membership.percent_bps'], '0');
  });

  test('both routes read that rail through the same helper', () => {
    assert.match(intentFn, /getCommissionConfig\(svc, 'membership'\)/);
    assert.match(checkoutFn, /getCommissionConfig\(svc, 'membership'\)/);
    assert.match(intentFn, /calculateCommission\(type\.price_pence, membershipCfg, 'membership'\)/);
    assert.match(checkoutFn, /calculateCommission\(t\.price_pence, membershipCfg, 'membership'\)/);
  });

  test('the wallet-only key is no longer read on any payment path', () => {
    assert.ok(!code(checkoutFn).includes('fees.hub_membership.flat_pence'),
      'wallet-checkout still reads the old membership fee key');
    const paths = ['supabase/functions/create-hub-membership-intent/index.ts',
                   'supabase/functions/wallet-checkout/index.ts',
                   'supabase/functions/confirm-hub-membership/index.ts'];
    for (const p of paths) {
      assert.ok(!code(read(p)).includes('fees.hub_membership.flat_pence'), `${p} still reads it`);
    }
    assert.match(feeMig, /DEPRECATED — no longer read by any payment path/);
  });

  test('and the fee is still added ON TOP, so the hub gets the full price', () => {
    assert.match(intentFn, /const totalPence = type\.price_pence \+ flatFee/);
    assert.match(checkoutFn, /const debitTotal = t\.price_pence \+ flatFee/);
    // Wallet transfers the FACE price to the hub, not the debit.
    assert.match(checkoutFn, /amountPence: t\.price_pence,/);
  });

  test('Junior costs the same either way, and the hub nets the same', () => {
    const r = runSql(`
      select face_pence::text f, fee_pence::text x, total_pence::text t
        from public.membership_quote(
          (select id from public.hub_membership_types
            where name = 'Junior' and price_pence = 1000
              and hub_id = (select id from public.hubs where slug = 'demo-rowing-club')));`)[0];
    assert.equal(r.f, '1000');
    assert.equal(r.x, '95');
    assert.equal(r.t, '1095');   // card total AND wallet debit
  });
});

/* ── the quote ────────────────────────────────────────────────────────────── */

describe('the checkout is told what it will charge, by the thing that charges', () => {
  test('membership_quote computes from the tier row and the same rail', () => {
    assert.match(quoteMig, /from public\.hub_membership_types where id = p_type and is_active/);
    assert.match(quoteMig, /key = 'fees\.membership\.percent_bps'/);
    assert.match(quoteMig, /key = 'fees\.membership\.fixed_pence'/);
    assert.match(quoteMig, /v_fee := \(t\.price_pence \* pct\) \/ 10000 \+ fix;/);
  });

  test('it grants nothing and takes no payment', () => {
    assert.match(quoteMig, /stable/);
    assert.ok(!/insert into|update .*set|delete from/i.test(
      quoteMig.slice(quoteMig.indexOf('create or replace function public.membership_quote'),
                     quoteMig.indexOf('comment on function public.membership_quote'))));
  });

  test('an unknown or inactive tier yields no quote', () => {
    assert.equal(runSql(`select count(*)::text c from public.membership_quote(gen_random_uuid());`)[0].c, '0');
  });

  test('a free tier quotes zero and never reaches a paid checkout', () => {
    const r = runSql(`select total_pence::text t, fee_pence::text f from public.membership_quote(
      (select id from public.hub_membership_types where price_pence = 0 limit 1));`)[0];
    assert.equal(r.t, '0');
    assert.equal(r.f, '0');
    // And the paid function refuses one outright.
    assert.match(intentFn, /This tier is free — join directly\./);
  });

  test('both clients read the quote instead of mirroring a constant', () => {
    assert.match(web('lib/hubs-client.ts'), /rpc\("membership_quote", \{ p_type: membershipTypeId \}\)/);
    assert.match(appApi, /rpc\('membership_quote', \{ p_type: membershipTypeId \}\)/);
    // Comments stripped: the replacement documents what it replaced.
    assert.ok(!/HUB_MEMBERSHIP_FEE_PENCE\s*=\s*\d+/.test(code(appApi)), 'the stale display constant is still defined');
    assert.ok(!code(appHub).includes('HUB_MEMBERSHIP_FEE_PENCE'), 'the app still uses the mirrored constant');
  });
});

/* ── nothing charges until the final action ───────────────────────────────── */

describe('nothing charges until the customer says so', () => {
  test('the tier list has ONE action per tier, and it only opens the checkout', () => {
    assert.match(panel, /onClick=\{\(\) => setPayTier\(t\)\}[\s\S]{0,240}Join\s*\n\s*<\/button>/);
    // The repeated wallet/card pills are gone.
    assert.ok(!code(panel).includes('Pay from wallet ·'), 'the stacked wallet pill is still there');
    assert.ok(!code(panel).includes('Pay by card ·'), 'the stacked card pill is still there');
  });

  test('the panel can no longer take a payment at all', () => {
    const c = code(panel);
    for (const gone of ['startMembershipPayment', 'walletCheckout', 'confirmMembership', 'PaymentCheckout']) {
      assert.ok(!c.includes(gone), `the panel can still charge directly (${gone})`);
    }
  });

  test('Renew opens the checkout rather than paying', () => {
    assert.match(panel, /onClick=\{\(\) => setPayTier\(myTier!\)\}[\s\S]{0,200}Renew membership/);
    assert.match(panel, /isRenewal/);
  });

  test('choosing a payment method does not charge', () => {
    // MethodRow only calls onSelect, which is setMethod.
    assert.match(checkout, /onClick=\{onSelect\}/);
    const row = checkout.slice(checkout.indexOf('function MethodRow'));
    for (const gone of ['startMembershipPayment', 'walletCheckout', 'confirmMembership']) {
      assert.ok(!row.includes(gone), `selecting a method can charge (${gone})`);
    }
  });

  test('only the explicit Pay button commits', () => {
    assert.match(checkout, /onClick=\{pay\}/);
    assert.match(checkout, /`Pay \$\{gbp\(quote\.total_pence\)\}`/);
    // And it is disabled until the server has quoted a total.
    assert.match(checkout, /const canPay = !busy && total != null/);
  });
});

/* ── disclosure ───────────────────────────────────────────────────────────── */

describe('the summary says what will be taken', () => {
  test('face price, fee and total are all shown', () => {
    assert.match(checkout, /<dt className="text-ink-soft">Membership<\/dt>/);
    assert.match(checkout, /gbp\(quote\.face_pence\)/);
    assert.match(checkout, /OneShetland fee/);
    assert.match(checkout, /gbp\(quote\.fee_pence\)/);
    assert.match(checkout, /Total today/);
    assert.match(checkout, /gbp\(quote\.total_pence\)/);
  });

  test('the fee line is hidden only when there is no fee', () => {
    assert.match(checkout, /\{quote\.fee_pence > 0 && \(/);
  });

  test('the total stays visible while entering a new card', () => {
    assert.match(checkout, /Total today \{gbp\(total \?\? 0\)\}/);
    assert.match(checkout, /payLabel=\{`Pay \$\{gbp\(total \?\? 0\)\}`\}/);
  });

  test('the term is shown, and a renewal says it is added to what they have', () => {
    assert.match(checkout, /PERIOD_TERM/);
    assert.match(checkout, /year: "1 year"/);
    assert.match(checkout, /valid until \$\{fmt\(newExpiry\)\}/);
    assert.match(checkout, /you keep the time you&apos;ve already paid for/);
  });

  test('the app sheet shows the quoted fee and total, correctly labelled', () => {
    assert.match(appHub, /label: 'OneShetland fee', amountPence: quote\.fee_pence/);
    assert.match(appHub, /totalPence=\{quote\?\.total_pence \?\? 0\}/);
    assert.ok(!code(appHub).includes("'Booking fee'"), 'the app still calls it a booking fee');
  });
});

/* ── payment methods ──────────────────────────────────────────────────────── */

describe('payment methods live inside the checkout', () => {
  test('a saved card is the default when there is one', () => {
    assert.match(checkout, /useState<Method>\(hasSavedCard \? "saved" : "new"\)/);
    assert.match(checkout, /title="Your saved card"/);
  });

  test('card state is resolved on the server, not in the browser', () => {
    assert.match(hubPage, /getPaymentState\(await createClient\(\), account\.id\)\)\.card_on_file/);
    assert.ok(!code(panel).includes('has_payment_method'));
  });

  test('another card remains available', () => {
    assert.match(checkout, /Use another card/);
    // The chosen method still decides the route — it is now named rather than
    // inlined, because the saved-card branch must also refuse to fall through
    // to the card form.
    assert.match(checkout, /const usingSavedCard = method === "saved"/);
    assert.match(checkout, /startMembershipPayment\(tier\.id, attemptId\(\), usingSavedCard\)/);
  });

  test('the wallet shows its balance and refuses when short', () => {
    assert.match(checkout, /OneShetland Wallet/);
    assert.match(checkout, /Balance \$\{gbp\(walletPence\)\}/);
    assert.match(checkout, /not enough for \$\{gbp\(total \?\? 0\)\}/);
    assert.match(checkout, /disabled=\{walletPence != null && !walletCovers\}/);
    assert.match(checkout, /method !== "wallet" \|\| walletCovers/);
  });

  test('a free tier keeps its own light path', () => {
    assert.match(panel, /Join free/);
    assert.match(panel, /onClick=\{\(\) => freeJoin\(t\.id\)\}/);
    // freeJoin never touches a paid checkout.
    const fn = panel.slice(panel.indexOf('const freeJoin'), panel.indexOf('const freeJoin') + 400);
    assert.ok(!fn.includes('setPayTier'));
  });
});

/* ── wording ──────────────────────────────────────────────────────────────── */

describe('nothing claims membership renews itself', () => {
  test('the active membership says Valid until', () => {
    assert.match(panel, /Valid until \{new Date\(membership\.paid_until\)/);
    assert.ok(!code(panel).includes('Renews/expires'));
  });

  test('so do both membership cards', () => {
    assert.match(webCard, /valid \? "Valid until" : "Expired"/);
    assert.match(appCards, /valid \? 'Valid until' : 'Expired'/);
  });

  test('the app hub screen and its policy line agree', () => {
    assert.match(appHub, /`Valid until \$\{fmtDate\(membership\.paid_until\)\}`/);
    assert.match(appHub, /does not renew automatically/);
  });

  test('and the checkout says it too', () => {
    assert.match(checkout, /doesn&apos;t renew automatically/);
  });
});

/* ── the safety architecture ──────────────────────────────────────────────── */

describe('payment safety is untouched', () => {
  test('price, currency and destination stay server-authoritative', () => {
    assert.match(intentFn, /\.from\('hub_membership_types'\)/);
    assert.match(intentFn, /currency:\s+'gbp'/);
    assert.match(intentFn, /baseParams\['transfer_data\[destination\]'\] = hub\.stripe_account_id/);
    assert.ok(!code(intentFn).includes('body.amount'));
  });

  test('the self-payment guard is still there, before the fee and the intent', () => {
    assert.match(intentFn, /const selfPay = await selfPaymentBlock\(svc, user\.id, hub\.stripe_account_id\)/);
    const i = intentFn.indexOf('const selfPay =');
    assert.ok(i < intentFn.indexOf('getCommissionConfig(svc,'));
    assert.ok(i < intentFn.indexOf('createPaymentIntent({'));
    assert.match(checkoutFn, /const selfPayMem = await selfPaymentBlock/);
  });

  test('the attempt reference and both keys survive', () => {
    assert.match(intentFn, /typeof client_request_id !== 'string'/);
    assert.match(intentFn, /`member-\$\{user\.id\}-\$\{type\.id\}-\$\{client_request_id\}`/);
    assert.match(intentFn, /`member-form-\$\{user\.id\}-\$\{type\.id\}-\$\{client_request_id\}`/);
    // The checkout mints one per opening and holds it through SCA.
    assert.match(checkout, /const attemptId = useAttemptId\(session\)/);
    assert.match(checkout, /setSession\(\(n\) => n \+ 1\)/);
    assert.match(appHub, /const memberAttempt = useAttemptId\(memberSession\)/);
  });

  test('SCA still resumes the same PaymentIntent', () => {
    assert.match(intentFn, /status: 'requires_action', clientSecret: outcome\.clientSecret, payment_intent_id: outcome\.id/);
    assert.match(web('lib/hubs-client.ts'), /settleSavedCardPayment\(data as ScaStart\)/);
  });

  test('activation is unchanged and still exactly once', () => {
    assert.match(read('supabase/functions/_shared/fulfilment.ts'), /case 'hub_membership':/);
    assert.match(read('supabase/functions/_shared/fulfilment.ts'), /\.rpc\('activate_hub_membership'/);
    const r = runSql(`select
      case when has_function_privilege('anon','public.activate_hub_membership(uuid,uuid,uuid,text,integer,text,integer,text)','execute')
             or has_function_privilege('authenticated','public.activate_hub_membership(uuid,uuid,uuid,text,integer,text,integer,text)','execute')
           then 'CALLABLE' else 'none' end as g,
      case when exists (select 1 from pg_indexes where tablename='hub_members'
                         and indexdef ilike '%unique%stripe_payment_intent_id%') then 'present' else 'MISSING' end as i;`)[0];
    assert.equal(r.g, 'none');
    assert.equal(r.i, 'present');
  });

  // A moving number, and each move was a real event rather than a test being
  // loosened: 2 when written, 1 after Leave hub hard-deleted a paid membership
  // (the defect the history work exists to stop), and 2 again after a genuine
  // Junior purchase on 26 August 2026. It is pinned so that a CHANGE has to be
  // explained, not so that the value never changes.
  test('the real membership was not touched', () => {
    const r = runSql(`select count(*)::text c, coalesce(max(member_no),'-') n
                        from public.hub_members where stripe_payment_intent_id is not null;`)[0];
    assert.equal(r.c, '2', 'the number of paid memberships changed');
  });

  test('other paygates unchanged', () => {
    const f = read('supabase/functions/_shared/fulfilment.ts');
    for (const t of ['local_wallet_topup', 'unit_purchase', 'gift_purchase', 'event_tickets',
                     'hub_donation', 'hub_membership', 'product_order', 'shift_boost']) {
      assert.match(f, new RegExp(`case '${t}':`), `${t} lost its fulfiller`);
    }
  });

  test('the checkout component exists and is the only paid entry point', () => {
    assert.ok(existsSync(join(WEB_ROOT, 'components/hubs/MembershipCheckout.tsx')));
    assert.equal((panel.match(/<MembershipCheckout/g) ?? []).length, 2); // active-member + tier list
  });
});
