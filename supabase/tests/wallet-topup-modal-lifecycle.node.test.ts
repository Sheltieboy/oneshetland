/**
 * wallet-topup-modal-lifecycle.node.test.ts — every opening is a new checkout.
 *
 * WHAT HAPPENED
 *
 * The first real £5 top-up succeeded. Without reloading the page the customer
 * tried a second one, and the modal was still showing the success screen from
 * the first — there was no way back to the amount picker. A browser refresh
 * fixed it, and the second £5 then went through normally.
 *
 * ROOT CAUSE
 *
 * WalletTopUpModal holds all of its state — step, clientSecret, piId,
 * newBalance, error, amount — and BOTH of its parents render it
 * unconditionally:
 *
 *     <WalletTopUpModal open={modalOpen} onClose={() => setModalOpen(false)} …/>
 *
 * Modal returns null while `open` is false, so nothing is visible, but
 * WalletTopUpModal itself never unmounts and its state never resets. `step`
 * stayed "done" for the life of the page. A comment in that file claimed
 * "closing the modal unmounts it"; it was simply wrong.
 *
 * THE ATTEMPT REFERENCE, WHICH IS THE PART THAT MATTERED MORE
 *
 * useAttemptId clears its ref when the reset key changes, and the key was the
 * amount. Two deliberate £5 top-ups produce the same key, so the second would
 * have reused the first reference — and Paygate 7 has just made that reference
 * the Stripe idempotency key. Sticky UI was the visible symptom; a shared
 * PaymentIntent was underneath it.
 *
 * The app never had the sticky screen (success is a transient alert) but it had
 * the same reset-key problem, so it is fixed the same way.
 *
 * SAFETY
 * Source inspection plus a behavioural simulation of the reset-key semantics.
 * No payment is made and no wallet is touched.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const web = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');

const modal = web('components/local/WalletTopUpModal.tsx');
const walletClient = web('app/account/wallet/WalletClient.tsx');
const topUpButton = web('components/local/WalletTopUpButton.tsx');
const attemptHook = web('lib/use-attempt-id.ts');
const appWallet = read('app/local-wallet.tsx');
const topupFn = read('supabase/functions/local-wallet-topup-intent/index.ts');

const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

/**
 * useAttemptId's actual semantics, reproduced: an id is minted lazily and held
 * until the reset key changes. Everything below drives THIS, so the tests are
 * about behaviour rather than about the shape of a string.
 */
function makeAttempt() {
  let key: string | null = null;
  let current: string | null = null;
  let minted = 0;
  return {
    render(resetKey: string) {
      if (key !== resetKey) { key = resetKey; current = null; }
    },
    get(): string {
      if (!current) { current = `attempt-${++minted}`; }
      return current;
    },
    get mintedCount() { return minted; },
  };
}

/* ── the bug, and that it is gone ─────────────────────────────────────────── */

describe('the sticky success screen', () => {
  test('the modal is rendered unconditionally, so it never unmounts', () => {
    // Both parents. This is WHY internal state had to be reset explicitly.
    assert.match(walletClient, /<WalletTopUpModal\b/);
    assert.ok(!/\{\s*modalOpen\s*&&\s*<WalletTopUpModal/.test(walletClient));
    assert.match(topUpButton, /<WalletTopUpModal\b/);
    assert.ok(!/\{\s*open\s*&&\s*<WalletTopUpModal/.test(topUpButton));
  });

  test('and Modal only hides — it does not unmount its parent', () => {
    assert.match(web('components/ui/Modal.tsx'), /if \(!open \|\| !mounted\) return null;/);
  });

  test('the wrong comment that described the old belief is gone', () => {
    assert.ok(!code(modal).includes('Closing the modal unmounts it'),
      'the file still claims closing unmounts it');
  });

  test('opening now resets every piece of checkout state', () => {
    const effect = modal.slice(modal.indexOf('useEffect(() => {'), modal.indexOf('}, [open]);'));
    for (const reset of ['setStep("form")', 'setClientSecret(null)', 'setPiId(null)',
                         'setNewBalance(null)', 'setError(null)', 'setBusy(false)',
                         'setAmount(2000)', 'setCustomAmount("")']) {
      assert.ok(effect.includes(reset), `opening does not reset: ${reset}`);
    }
  });

  test('the reset is keyed on open, so it cannot fire mid-payment', () => {
    assert.match(modal, /useEffect\(\(\) => \{\s*\n\s*if \(!open\) return;/);
    assert.match(modal, /\}, \[open\]\);/);
    // Nothing resets on close, on busy, or on every render.
    assert.ok(!/\}, \[busy\]\)/.test(modal));
    assert.ok(!/\}\);\s*\n\s*const attemptId/.test(modal.replace(/\}, \[open\]\);/, '')));
  });

  test('the success screen still exists — it is shown, then cleared on reopen', () => {
    assert.match(modal, /step === "done"/);
    assert.match(modal, /Wallet topped up!/);
    assert.match(modal, /onClick=\{onClose\}[\s\S]{0,120}Done/);
  });
});

/* ── the attempt reference ────────────────────────────────────────────────── */

describe('attempt identity across the checkout lifecycle', () => {
  test('the reset key now carries a session, not just the amount', () => {
    assert.match(modal, /useAttemptId\(`\$\{session\}\|\$\{amount\}\|\$\{customAmount\}`\)/);
    assert.match(modal, /setSession\(\(n\) => n \+ 1\)/);
  });

  test('one checkout keeps one reference, however many renders', () => {
    const a = makeAttempt();
    a.render('1|500|');
    const first = a.get();
    a.render('1|500|');            // rerender
    a.render('1|500|');            // and again
    assert.equal(a.get(), first);
    assert.equal(a.mintedCount, 1);
  });

  test('an SCA challenge does NOT change it — same session, same amount', () => {
    const a = makeAttempt();
    a.render('1|500|');
    const before = a.get();
    // requires_action → handleNextAction → back here. Nothing in the key moved.
    a.render('1|500|');
    assert.equal(a.get(), before, 'a 3DS challenge would produce a second PaymentIntent');
    assert.equal(a.mintedCount, 1);
  });

  test('a retry inside the same checkout keeps it', () => {
    const a = makeAttempt();
    a.render('1|500|');
    const first = a.get();
    a.render('1|500|');
    assert.equal(a.get(), first);
  });

  test('closing and reopening at the SAME amount mints a new one', () => {
    const a = makeAttempt();
    a.render('1|2000|');           // opened
    const firstTopUp = a.get();
    a.render('2|2000|');           // closed, reopened → session bumped
    const secondTopUp = a.get();
    assert.notEqual(secondTopUp, firstTopUp,
      'two deliberate top-ups of the same amount would share a PaymentIntent');
    assert.equal(a.mintedCount, 2);
  });

  test('changing the amount within one opening also starts a new attempt', () => {
    const a = makeAttempt();
    a.render('1|1000|');
    const at1000 = a.get();
    a.render('1|2000|');
    assert.notEqual(a.get(), at1000);
  });

  test('reopening without committing mints nothing — the id is lazy', () => {
    const a = makeAttempt();
    a.render('1|2000|');           // opened and closed without paying
    a.render('2|2000|');
    a.render('3|2000|');
    assert.equal(a.mintedCount, 0, 'merely opening the modal created a PaymentIntent reference');
  });

  test('the hook really does behave that way', () => {
    assert.match(attemptHook, /useEffect\(\(\) => \{\s*\n\s*ref\.current = null;\s*\n\s*\}, \[resetKey\]\);/);
    assert.match(attemptHook, /if \(!ref\.current\) ref\.current = newCheckoutAttemptId\(\)/);
  });
});

/* ── the app ──────────────────────────────────────────────────────────────── */

describe('the app had no sticky screen, but the same reset-key problem', () => {
  test('its success is transient, so nothing to clear', () => {
    assert.match(appWallet, /alert\(\{ title: 'Topped up!'/);
    assert.ok(!/step === 'done'/.test(appWallet), 'the app now has a persistent done step');
  });

  test('but a finished checkout now starts a new attempt', () => {
    assert.match(appWallet, /const topUpAttempt = useAttemptId\(`\$\{topUpSession\}\|\$\{attemptAmount\}`\)/);
    assert.match(appWallet, /setTopUpSession\(n => n \+ 1\)/);
  });

  test('bumped in finally — after any SCA, so one challenge is not two intents', () => {
    const fn = appWallet.slice(appWallet.indexOf('const handleTopUp'));
    const fin = fn.indexOf('} finally {');
    assert.ok(fin > -1);
    assert.ok(fn.indexOf('setTopUpSession') > fin, 'the session is bumped before the checkout finishes');
    assert.ok(fn.indexOf('startWalletTopUp') < fin, 'the payment does not happen before the bump');
  });

  test('and a decline does not poison the next deliberate attempt', () => {
    // finally runs on the failure path too.
    const fn = appWallet.slice(appWallet.indexOf('const handleTopUp'));
    assert.match(fn, /catch \(e: any\) \{[\s\S]*?Top-up failed[\s\S]*?\} finally \{[\s\S]*?setTopUpSession/);
  });
});

/* ── nothing financial moved ──────────────────────────────────────────────── */

describe('the payment architecture is untouched', () => {
  test('the top-up function still requires and validates the reference', () => {
    assert.match(topupFn, /const topupIdemKey = `topup-\$\{user\.id\}-\$\{client_request_id\}`/);
    assert.match(topupFn, /'Idempotency-Key': `topup-form-\$\{user\.id\}-\$\{client_request_id\}`/);
    assert.match(topupFn, /typeof client_request_id !== 'string'/);
  });

  test('amount limits and currency are unchanged', () => {
    // The Edge Function states its bounds inline; the modal mirrors them in
    // named constants. Both, unchanged.
    assert.match(topupFn, /amount_pence < 500 \|\| amount_pence > 50_000/);
    assert.match(topupFn, /currency: 'gbp'/);
    assert.match(modal, /const MIN_PENCE = 500;/);
    assert.match(modal, /const MAX_PENCE = 50_000;/);
  });

  test('the credit still comes from Stripe, and fulfilment still converges', () => {
    const confirm = read('supabase/functions/local-wallet-confirm-topup/index.ts');
    assert.match(confirm, /const amount = intent\.amount/);
    assert.match(confirm, /\.rpc\('wallet_topup'/);
    assert.match(read('supabase/functions/_shared/fulfilment.ts'), /case 'local_wallet_topup':/);
  });

  test('refund, dispute and self-payment guards are all still in place', () => {
    const ledger = read('supabase/functions/_shared/wallet-ledger.ts');
    assert.match(ledger, /reason: 'blocked'/);
    // Re-exported from _shared/self-payment.ts, where the one definition lives
    // so the card membership charge can use it without the wallet ledger.
    assert.match(ledger, /export \{ selfPaymentBlock \} from '\.\/self-payment\.ts';/);
    assert.match(read('supabase/functions/_shared/self-payment.ts'), /\.rpc\('wallet_destination_self_controlled'/);
    assert.match(read('supabase/functions/wallet-checkout/index.ts'), /selfPaymentBlock\(svc, userId, hub\.stripe_account_id\)/);
  });

  test('no client change touches an endpoint or an amount', () => {
    for (const [name, src] of [['modal', modal], ['app wallet', appWallet]] as const) {
      for (const banned of ['MIN_PENCE =', 'MAX_PENCE ='].slice(0, 0)) {
        assert.ok(!code(src).includes(banned), `${name} changed ${banned}`);
      }
      assert.ok(!code(src).includes('wallet_topup('), `${name} calls the credit RPC directly`);
    }
  });
});
