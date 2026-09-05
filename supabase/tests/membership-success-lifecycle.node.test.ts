/**
 * membership-success-lifecycle.node.test.ts — a paid-for checkout stays paid for.
 *
 * THE DEFECT
 *
 * A real TEST purchase went through on the saved card, and with no further
 * click the same modal came back as "Renew membership · Junior · valid until
 * 26 August 2028 · Total today £10.95" with a live Pay button.
 *
 * HubMembershipPanel renders <MembershipCheckout> in TWO places behind early
 * returns: once in the active-member branch and once in the non-member branch.
 * Paying called router.refresh(), the refreshed membership became active, and
 * the panel switched branches — so React unmounted the checkout and mounted a
 * different one. Every piece of state the checkout held itself was reset:
 * step went from "done" back to "review", isRenewal was now true, and the mount
 * effect minted a FRESH attempt id automatically. The 2028 date was never
 * granted; it was the modal previewing a second year on top of the one just
 * bought.
 *
 * The purchase itself was correct — one PaymentIntent, one purchase row, one
 * year — but nothing about the UI stopped a second one being a click away.
 *
 * THE FIX
 *
 * The completed fact moved to the panel, which does not unmount, and the page
 * refresh moved from the moment of payment to the moment the receipt is closed.
 *
 * SAFETY
 * Source-level, plus read-only assertions on production. No payment made, no
 * refund issued, Stripe untouched.
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
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

const checkoutRaw = web('components/hubs/MembershipCheckout.tsx');
const checkout = code(checkoutRaw);
const panel    = code(web('components/hubs/HubMembershipPanel.tsx'));
const appHub   = code(read('app/hubs/[id].tsx'));
const refundFn = code(read('supabase/functions/refund-payment/index.ts'));

/** The JSX rendered once a purchase has completed. */
const doneBranch = (() => {
  const start = checkout.indexOf('{step === "done" ? (');
  const end = checkout.indexOf(') : step === "card"', start);
  assert.ok(start > 0 && end > start, 'could not locate the success branch');
  return checkout.slice(start, end);
})();

function rowsOf(out: string): Record<string, unknown>[] {
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
}
const runSql = (sql: string) => rowsOf(execFileSync('npx',
  ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }));

/* ── 1. success is the end of the checkout ────────────────────────────────── */

describe('a completed purchase reaches a terminal success', () => {
  test('both card and wallet finish through the one terminal path', () => {
    assert.match(checkout, /function finish\(paidUntil: string \| null\)/);
    assert.match(checkout, /finish\(w\?\.paid_until \?\? null\)/);            // wallet
    assert.match(checkout, /finish\(done\?\.paid_until \?\? null\)/);          // saved card and card form
    assert.equal((checkout.match(/finish\(/g) ?? []).length, 4);               // one definition, three call sites
  });

  test('the success screen offers only Done', () => {
    assert.match(doneBranch, /Done<\/button>/);
    assert.doesNotMatch(doneBranch, /Pay /, 'a Pay button survives in the completed checkout');
    assert.doesNotMatch(doneBranch, /onClick=\{pay\}/);
  });

  test('the expiry shown is the one the server granted', () => {
    assert.match(doneBranch, /completed\?\.paidUntil/);
    assert.match(doneBranch, /fmt\(new Date\(completed\.paidUntil\)\)/);
    assert.match(checkout, /const done = await confirmMembership\(res\.payment_intent_id\)/);
  });

  test('a lifetime membership is not described as expiring', () => {
    assert.match(doneBranch, /has no expiry/);
  });
});

/* ── 2. the refresh cannot reopen it ──────────────────────────────────────── */

describe('paying does not refresh the page underneath the receipt', () => {
  test('the checkout no longer refreshes at all', () => {
    // router.refresh() during payment is what switched the panel's branch and
    // remounted this component.
    assert.doesNotMatch(checkout, /router\.refresh\(\)/);
    assert.doesNotMatch(checkout, /useRouter/);
  });

  test('closing the receipt is what refreshes', () => {
    assert.match(panel, /const closeCheckout = \(\) => \{/);
    assert.match(panel, /if \(hadPaid\) refresh\(\)/);
  });

  test('both checkout positions share that close', () => {
    const rendered = (panel.match(/<MembershipCheckout/g) ?? []).length;
    const closes = (panel.match(/onClose=\{closeCheckout\}/g) ?? []).length;
    assert.ok(rendered > 0);
    assert.equal(closes, rendered, `${rendered} checkouts but ${closes} use closeCheckout`);
  });
});

/* ── 3. the completed fact outlives a remount ─────────────────────────────── */

describe('a remount cannot resurrect a chargeable checkout', () => {
  test('the completed purchase is held by the panel, not the checkout', () => {
    assert.match(panel, /const \[paid, setPaid\] = useState<\{ tierName: string; paidUntil: string \| null \} \| null>\(null\)/);
    const rendered = (panel.match(/<MembershipCheckout/g) ?? []).length;
    assert.equal((panel.match(/completed=\{paid\}/g) ?? []).length, rendered);
    assert.equal((panel.match(/onPaid=\{setPaid\}/g) ?? []).length, rendered);
  });

  test('a remounted checkout starts finished when the purchase is done', () => {
    assert.match(checkout, /useState<"review" \| "card" \| "done">\(completed \? "done" : "review"\)/);
  });

  test('and the open effect refuses to send it back to a Pay screen', () => {
    assert.match(checkout, /if \(completed\) \{ setStep\("done"\); return; \}/);
    // The guard has to run BEFORE the reset it is guarding against.
    assert.ok(checkout.indexOf('if (completed) { setStep("done"); return; }')
            < checkout.indexOf('setStep("review");'));
  });
});

/* ── 4. one purchase, one attempt ─────────────────────────────────────────── */

describe('the finished attempt dies with the checkout', () => {
  test('no fresh attempt is minted just because the purchase completed', () => {
    // setSession sits after the completed-guard returns, so a remount of a
    // finished checkout does not reach it.
    assert.ok(checkout.indexOf('if (completed) { setStep("done"); return; }')
            < checkout.indexOf('setSession((n) => n + 1)'));
  });

  test('closing clears the completed purchase so a later renewal is a new one', () => {
    assert.match(panel, /setPaid\(null\)/);
    assert.match(panel, /setPayTier\(null\)/);
  });

  test('a later deliberate renewal opens a checkout that mints its own', () => {
    assert.match(panel, /onClick=\{\(\) => setPayTier\(myTier!\)\}/);
    assert.match(checkout, /setSession\(\(n\) => n \+ 1\)/);
    assert.match(checkout, /const attemptId = useAttemptId\(session\)/);
  });
});

/* ── 5. rendering success charges nothing ─────────────────────────────────── */

describe('a success render has no payment side effect', () => {
  test('nothing starts a payment outside the pay handler', () => {
    const payStart = checkout.indexOf('async function pay()');
    const payEnd = checkout.indexOf('return (', payStart);
    const payBody = checkout.slice(payStart, payEnd);
    assert.match(payBody, /startMembershipPayment\(/);
    // The only other call site is the card-form onPaid, which the customer
    // reaches by submitting the Payment Element.
    assert.equal((checkout.match(/startMembershipPayment\(/g) ?? []).length, 1);
    assert.equal((checkout.match(/walletCheckout\(/g) ?? []).length, 1);
  });

  test('no effect confirms or re-confirms a membership', () => {
    const effects = checkout.match(/useEffect\([\s\S]*?\}, \[[^\]]*\]\);/g) ?? [];
    for (const e of effects) {
      assert.doesNotMatch(e, /confirmMembership|startMembershipPayment|walletCheckout/,
        'an effect performs a payment action');
    }
  });

  test('confirmation happens once per completed route', () => {
    assert.equal((checkout.match(/confirmMembership\(/g) ?? []).length, 2); // saved-card + card-form
  });
});

/* ── 6. the saved-card fix is still in place ──────────────────────────────── */

describe('the saved-card regression stays fixed', () => {
  test('the flag still travels from the page to the checkout', () => {
    assert.match(code(web('app/hubs/[id]/page.tsx')), /hasSavedCard=\{hasSavedCard\}/);
    const rendered = (panel.match(/<MembershipCheckout/g) ?? []).length;
    assert.equal((panel.match(/hasSavedCard=\{hasSavedCard\}/g) ?? []).length, rendered);
  });

  test('the saved card is still the default and still refuses to fall through', () => {
    assert.match(checkout, /useState<Method>\(hasSavedCard \? "saved" : "new"\)/);
    assert.match(checkout, /if \(!usingSavedCard && res\.clientSecret\)/);
    assert.match(checkout, /if \(usingSavedCard\) \{\s*throw new Error\(/);
  });

  test('SCA still resumes the same intent', () => {
    assert.match(code(web('lib/hubs-client.ts')), /settleSavedCardPayment\(data as ScaStart\)/);
    assert.match(code(web('lib/stripe-sca.ts')), /handleNextAction\(\{ clientSecret: start\.clientSecret \}\)/);
  });
});

/* ── 7. the other surfaces ────────────────────────────────────────────────── */

describe('wallet and app are safe too', () => {
  test('the wallet route ends in the same terminal success', () => {
    assert.match(checkout, /const w = await walletCheckout\(\{ type: "hub_membership", membership_type_id: tier\.id \}, attemptId\(\)\)/);
    assert.match(checkout, /finish\(w\?\.paid_until \?\? null\)/);
  });

  test('the app shows a banner and needs a deliberate tap to buy again', () => {
    // No modal to remount: success is an in-page banner and the renew control
    // is an ordinary button the member has to press.
    assert.match(appHub, /setJoinSuccess\(\{ title: 'You\\'re in 🎉'/);
    assert.doesNotMatch(appHub, /joinSuccess[\s\S]{0,200}runMembershipPayment/);
  });
});

/* ── 8. nothing else moved ────────────────────────────────────────────────── */

describe('the rest of Paygate 8 is untouched', () => {
  test('the refund architecture is unchanged', () => {
    assert.match(refundFn, /record_membership_refund/);
    assert.match(refundFn, /reverse_transfer/);
  });

  // Counted every purchase in the table to say one refunded row survived.
  // Legitimate Membership E2E has since added more, so the counts moved and the
  // test said nothing about survival. What survival means, stated directly: a
  // fully refunded purchase still carries what it cost and what came back.
  test('a fully refunded purchase survives as a row, with its money intact', () => {
    const r = runSql(`select count(*)::text bad
                        from public.hub_membership_purchases
                       where refund_state = 'full'
                         and (total_pence is null or total_pence <= 0
                              or refunded_pence is distinct from total_pence);`)[0];
    assert.equal(r.bad, '0', 'a refunded purchase was zeroed out rather than kept and marked');
    const n = runSql(`select count(*)::text c from public.hub_membership_purchases
                       where refund_state = 'full';`)[0];
    assert.ok(Number(n.c) >= 1, 'no fully refunded purchase exists — this would pass vacuously');
  });

  // Measured from occurred_at, which is only right for a FIRST purchase. A
  // renewal extends from the paid_until it already had, so the second £1 test
  // purchase legitimately landed 731 days out — and a count pinned at 1 failed
  // for doing the correct thing. What one payment buys is a year ADDED, from
  // wherever the member's cover already reached.
  test('one payment intent buys exactly one year, renewal or not', () => {
    const r = runSql(`select count(*)::text bad
                        from public.hub_membership_purchases
                       where source = 'live' and period = 'year'
                         and paid_until_after is not null
                         and paid_until_after not between
                               coalesce(paid_until_before, occurred_at) + interval '360 days'
                           and coalesce(paid_until_before, occurred_at) + interval '370 days';`)[0];
    assert.equal(r.bad, '0', 'a yearly payment did not add about a year to the cover it extended');
    const n = runSql(`select count(*)::text c from public.hub_membership_purchases
                       where source = 'live' and period = 'year' and paid_until_after is not null;`)[0];
    assert.ok(Number(n.c) >= 1, 'no yearly purchase to check — this would pass vacuously');
  });
});
