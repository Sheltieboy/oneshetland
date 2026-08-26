/**
 * saved-card-invariants.node.test.ts — the saved card must stay the default.
 *
 * THE REGRESSION
 *
 * On an account with a card on file, the membership checkout opened the full
 * Stripe Payment Element — card number fields, Klarna, Revolut Pay, Amazon Pay
 * — instead of offering the saved card. No data was lost: the account's
 * profiles.has_payment_method was true throughout.
 *
 * app/hubs/[id]/page.tsx resolved hasSavedCard on the server and never passed
 * it to <HubMembershipPanel>. The prop defaults to false, so the panel told
 * MembershipCheckout there was no saved card, the "Your saved card" row was
 * never rendered, the method defaulted to "new", and Pay went to the card-form
 * branch — which enables automatic_payment_methods and therefore every wallet
 * Stripe offers. `git log -S` shows the prop was never passed since the line
 * was introduced.
 *
 * THIS HAS HAPPENED BEFORE. The comment at the top of app/basket/page.tsx
 * records the same class of failure: the basket sent no use_saved_card at all,
 * the server took its card-form branch, "and a buyer with a perfectly good
 * saved card was asked to type it in again". Two occurrences is a pattern, so
 * the tests below are structural: they assert the flag actually travels from
 * where it is resolved to where it is used, for every paygate that resolves one.
 *
 * SAFETY
 * Source-level only. No payment made, no refund issued, Stripe untouched.
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

/** Comments describe intent; only code enforces it. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

const hubPage   = code(web('app/hubs/[id]/page.tsx'));
const panel     = code(web('components/hubs/HubMembershipPanel.tsx'));
const checkout  = code(web('components/hubs/MembershipCheckout.tsx'));
const basket    = code(web('app/basket/page.tsx'));
const donate    = code(web('components/hubs/DonateModal.tsx'));
const gift      = code(web('components/local/GiftModal.tsx'));
const boost     = code(web('components/jobs/ShiftBoostModal.tsx'));
const unitModal = code(web('components/local/BuyUnitModal.tsx'));
const topUp     = code(web('components/local/WalletTopUpModal.tsx'));
const commerce  = code(web('lib/local-commerce-client.ts'));
const events    = code(web('lib/events-client.ts'));
const sca       = code(web('lib/stripe-sca.ts'));
const hubsClient= code(web('lib/hubs-client.ts'));
const appHub    = code(read('app/hubs/[id].tsx'));
const memberFn  = code(read('supabase/functions/create-hub-membership-intent/index.ts'));

/* ── 1. the exact regression ──────────────────────────────────────────────── */

describe('the saved-card flag reaches the membership checkout', () => {
  test('the hub page resolves it from the server', () => {
    assert.match(hubPage, /const hasSavedCard = account/);
    assert.match(hubPage, /getPaymentState\(await createClient\(\), account\.id\)\)\.card_on_file/);
  });

  test('and actually passes it to the panel', () => {
    // The regression in one line: resolved, then dropped on the floor.
    assert.match(hubPage, /hasSavedCard=\{hasSavedCard\}/,
      'the hub page computes hasSavedCard but never passes it — the panel defaults to false');
  });

  test('the panel forwards it to every checkout it renders', () => {
    const rendered = (panel.match(/<MembershipCheckout/g) ?? []).length;
    const forwarded = (panel.match(/hasSavedCard=\{hasSavedCard\}/g) ?? []).length;
    assert.ok(rendered > 0, 'the panel renders no checkout at all');
    assert.equal(forwarded, rendered,
      `${rendered} checkouts rendered but hasSavedCard forwarded to ${forwarded}`);
  });

  test('a resolved saved-card flag is never left unused on that page', () => {
    // Cheap standing guard for the whole class: if the page resolves the flag,
    // it has to use it. Nothing else on this page reads card state.
    const uses = (hubPage.match(/hasSavedCard/g) ?? []).length;
    assert.ok(uses >= 2, 'hasSavedCard is resolved but referenced only once');
  });
});

/* ── 2. what the checkout does with it ────────────────────────────────────── */

describe('the saved card is the default, and the only default', () => {
  test('the method starts on the saved card whenever there is one', () => {
    assert.match(checkout, /useState<Method>\(hasSavedCard \? "saved" : "new"\)/);
  });

  test('reopening the modal restores that default rather than keeping the last choice', () => {
    assert.match(checkout, /setMethod\(hasSavedCard \? "saved" : "new"\)/);
  });

  test('the saved-card row is offered only when a card exists', () => {
    assert.match(checkout, /\{hasSavedCard && \(\s*<MethodRow selected=\{method === "saved"\}/);
  });

  test('with no saved card the card form is the honest default', () => {
    assert.match(checkout, /title=\{hasSavedCard \? "Use another card" : "Pay by card"\}/);
  });

  test('Pay sends the method the customer actually chose', () => {
    assert.match(checkout, /const usingSavedCard = method === "saved"/);
    assert.match(checkout, /startMembershipPayment\(tier\.id, attemptId\(\), usingSavedCard\)/);
  });
});

/* ── 3. no silent fallback ────────────────────────────────────────────────── */

describe('a saved-card failure never becomes a card form', () => {
  test('only the new-card route may reach the Payment Element', () => {
    assert.match(checkout, /if \(!usingSavedCard && res\.clientSecret\)/);
  });

  test('a saved-card charge that does not complete raises an error instead', () => {
    assert.match(checkout, /if \(usingSavedCard\) \{\s*throw new Error\(/);
    assert.match(checkout, /Use another card/);
  });

  test('nothing anywhere flips the method to new card on failure', () => {
    for (const [name, src] of [
      ['membership', checkout], ['donation', donate], ['gift', gift],
      ['basket', basket], ['unit', unitModal], ['top-up', topUp],
    ] as const) {
      assert.doesNotMatch(src, /catch[\s\S]{0,200}setMethod\(["']new/,
        `${name} switches to the card form inside a catch`);
      assert.doesNotMatch(src, /catch[\s\S]{0,200}setUseNewCard\(true\)/,
        `${name} switches to the card form inside a catch`);
    }
  });

  test('the one re-request that exists is for a MISSING card, not a declined one', () => {
    // Shift Boost re-asks for the Elements form when the personal card simply
    // is not there. That is the cardless case, which is meant to see a form.
    // It is matched narrowly; any other failure goes to setError.
    assert.match(boost, /\/no saved card\/i\.test\(msg\)/);
    assert.match(boost, /setError\(/);
  });
});

/* ── 4. SCA is still one PaymentIntent ────────────────────────────────────── */

describe('an authenticated saved-card charge resumes the same intent', () => {
  test('the server returns THAT intent, not a new one', () => {
    assert.match(memberFn, /status: 'requires_action', clientSecret: outcome\.clientSecret, payment_intent_id: outcome\.id/);
  });

  test('the browser finishes it with handleNextAction', () => {
    assert.match(sca, /handleNextAction\(\{ clientSecret: start\.clientSecret \}\)/);
    assert.match(hubsClient, /settleSavedCardPayment\(data as ScaStart\)/);
  });

  test('no saved-card route charges off-session behind the customer', () => {
    for (const [name, src] of [['membership fn', memberFn], ['hubs client', hubsClient]] as const) {
      assert.doesNotMatch(src, /off_session['"]?\s*[:=]\s*['"]?true/, `${name} charges off-session`);
    }
  });

  test('a challenge the customer abandons is not treated as paid', () => {
    assert.match(sca, /return \{ outcome: "cancelled" \}/);
  });
});

/* ── 5. one deliberate checkout, one reference ────────────────────────────── */

describe('each deliberate checkout carries its own attempt', () => {
  test('the membership checkout mints a fresh one per opening', () => {
    assert.match(checkout, /const \[session, setSession\] = useState\(0\)/);
    assert.match(checkout, /const attemptId = useAttemptId\(session\)/);
    assert.match(checkout, /setSession\(\(n\) => n \+ 1\)/);
  });

  test('and holds it across the retry and the SCA challenge', () => {
    // Bumped only in the open effect — never inside pay().
    const payBody = checkout.slice(checkout.indexOf('async function pay()'));
    assert.doesNotMatch(payBody.slice(0, payBody.indexOf('return (')), /setSession\(/);
  });
});

/* ── 6. the cross-paygate matrix ──────────────────────────────────────────── */

/**
 * Two architectures are in use and both are legitimate.
 *
 *   SERVER-DECIDES — the client always asks for the saved card and the server
 *   knows whether one exists. Nothing client-side can forget a flag.
 *
 *   CLIENT-DECIDES — the client resolves card state and sends it. Faster to
 *   render the right thing, and the only shape that can break the way
 *   membership just did, so those are asserted end to end.
 */
describe('every card paygate still prefers the saved card', () => {
  const SERVER_DECIDES = [
    ['event tickets', events,    /use_saved_card: payWithWallet \? false : useSavedCard/],
    ['gifts',         gift,      /useSavedCard: true/],
    ['hub donation',  donate,    /useSavedCard: true/],
    ['pass / unit',   commerce,  /use_saved_card: useSavedCard/],
    ['wallet top-up', topUp,     /startWalletTopUp\(amount, attemptId\(\), true\)/],
    ['shift boost',   boost,     /useSavedCard: !useBusinessCard/],
  ] as const;

  for (const [name, src, re] of SERVER_DECIDES) {
    test(`${name} asks for the saved card by default`, () => {
      assert.match(src, re);
    });
  }

  test('the defaults in the shared clients are saved-card, not card-form', () => {
    assert.match(events,   /useSavedCard = true/);
    assert.match(commerce, /useSavedCard = true/);
  });

  test('marketplace resolves card state and sends it', () => {
    assert.match(basket, /setCardOnFile\(uid \? await fetchCardOnFile\(sb, uid\) : false\)/);
    assert.match(basket, /use_saved_card: payWith === "card" && cardOnFile === true && !useNewCard/);
  });

  test('marketplace shows the card form only on an explicit choice', () => {
    assert.match(basket, /cardOnFile && !useNewCard/);
  });

  test('hub membership resolves card state and sends it', () => {
    assert.match(hubPage, /hasSavedCard=\{hasSavedCard\}/);
    assert.match(checkout, /startMembershipPayment\(tier\.id, attemptId\(\), usingSavedCard\)/);
  });

  test('the app membership route reads card state directly and is unaffected', () => {
    // The app never had the prop to lose: it reads the profile it already holds.
    assert.match(appHub, /const useSaved = !!profile\.has_payment_method/);
    assert.match(appHub, /startHubMembershipPayment\(type\.id, memberAttempt\(\), useSaved\)/);
  });
});

/* ── 7. the rest of Paygate 8 is untouched ────────────────────────────────── */

describe('nothing else moved', () => {
  test('the fee is still one 95p rail', () => {
    // Every figure comes from the server quote; no pence value is written here.
    assert.match(checkout, /quote\.fee_pence/);
    assert.match(checkout, /gbp\(quote\.total_pence\)/);
    assert.doesNotMatch(checkout, /fee[_A-Za-z]*\s*[:=]\s*\d+/);
  });

  test('the self-payment guard still runs before the intent', () => {
    assert.match(memberFn, /selfPaymentBlock/);
    assert.ok(memberFn.indexOf('selfPaymentBlock') < memberFn.indexOf('createPaymentIntent('));
  });

  test('the wallet route is unchanged by any of this', () => {
    assert.match(checkout, /walletCheckout\(\{ type: "hub_membership", membership_type_id: tier\.id \}, attemptId\(\)\)/);
  });

  test('the refund work is untouched', () => {
    assert.match(code(read('supabase/functions/refund-payment/index.ts')), /record_membership_refund/);
  });
});
