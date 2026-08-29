/**
 * privacy-cookie-disclosure.node.test.ts — the privacy page tells the truth
 * about what the browser actually stores.
 *
 * W3A established the technical position by measurement: our own analytics is
 * opt-in and creates no identifier before consent, and Stripe's payment scripts
 * — which set __stripe_mid and __stripe_sid — were loading on every page
 * because a currency formatter lived in the Stripe module. That is fixed;
 * Stripe now loads only where a payment or card-management surface needs it.
 *
 * The privacy page described the analytics honestly but said nothing about the
 * Stripe cookies. These tests hold the page to what is deployed, and — just as
 * importantly — hold it back from the claims it must NOT make: that Stripe
 * cookies are everywhere, that the analytics banner governs them, or that
 * Stripe's fraud cookies are advertising.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(WEB, p), 'utf8');

const page = read('app/privacy/page.tsx');
/** The Analytics & cookies section only. */
const section = page.slice(page.indexOf('<L h="Analytics'), page.indexOf('<L h="AI features'));

/** Rough prose, with JSX entities resolved, for wording assertions. */
const prose = section
  .replace(/<[^>]+>/g, ' ')
  .replace(/&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
  .replace(/&hellip;/g, '…').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ');

/* ── 1. Our analytics ───────────────────────────────────────────────────── */

describe('the page says our analytics is optional', () => {
  test('it is opt-in, in the banner', () => {
    assert.match(prose, /opt-in/i);
    assert.match(prose, /only runs .{0,30}if you accept it/i);
    assert.match(prose, /consent banner/i);
  });

  test('it states that nothing is created before consent', () => {
    assert.match(prose, /no analytics identifier is created/i);
    assert.match(prose, /nothing is stored in your browser and nothing is sent/i);
  });

  test('and that declining keeps it off', () => {
    assert.match(prose, /if you decline, it stays off/i);
  });
});

/* ── 2. Necessary and functional storage ────────────────────────────────── */

describe('the page distinguishes storage the site needs', () => {
  test('sign-in, the consent answer and user-set things are named', () => {
    assert.match(prose, /sign-in session/i);
    assert.match(prose, /answer to the analytics banner/i);
    assert.match(prose, /basket/i);
    assert.match(prose, /saved preference/i);
  });

  test('and says none of it profiles you for advertising', () => {
    assert.match(prose, /None of this is used for advertising profiling/i);
  });
});

/* ── 3. Stripe ──────────────────────────────────────────────────────────── */

describe('the page describes Stripe as deployed', () => {
  test('Stripe loads only on payment or card-management surfaces', () => {
    assert.match(prose, /only on pages where you are actually paying or managing a saved card/i);
    assert.match(prose, /not on ordinary content pages/i);
  });

  test('it names what Stripe may collect and why', () => {
    assert.match(prose, /transactional information and device-identifying information/i);
    assert.match(prose, /cookies and similar technologies/i);
    for (const purpose of ['process the payment', 'authenticate you', 'fraud and loss prevention', 'performance of its own services']) {
      assert.ok(prose.toLowerCase().includes(purpose.toLowerCase()), `missing purpose: ${purpose}`);
    }
  });

  test('both observed cookies are named, with purpose and duration', () => {
    assert.match(prose, /__stripe_mid — set by Stripe, for fraud prevention\. Lasts approximately one year/i);
    assert.match(prose, /__stripe_sid — set by Stripe, for fraud prevention\. Lasts approximately 30 minutes/i);
  });

  test('the list is presented as what we observe, not an exhaustive promise', () => {
    assert.match(prose, /currently see in our integration/i);
    assert.match(prose, /Stripe may use others/i);
  });

  test('both official Stripe links are present', () => {
    assert.match(section, /href="https:\/\/stripe\.com\/legal\/privacy-center"/);
    assert.match(section, /href="https:\/\/stripe\.com\/cookie-settings"/);
  });

  test('full card details are neither received nor stored', () => {
    assert.match(prose, /never receives or stores your full card details/i);
  });
});

/* ── 4. The claims it must NOT make ─────────────────────────────────────── */

describe('the wording avoids the claims that would be untrue', () => {
  test('it does not say Stripe cookies are on every page', () => {
    assert.ok(!/stripe[^.]{0,80}every page/i.test(prose),
      'Stripe loads only on payment surfaces — saying otherwise would be wrong');
  });

  test('it does not claim the banner controls necessary or payment-security storage', () => {
    assert.match(prose, /separate from your analytics choice/i);
    assert.match(prose, /does not switch off the storage needed to sign you in or to take a payment securely/i);
  });

  test('it does not describe Stripe\'s fraud cookies as advertising', () => {
    assert.match(prose, /payment-security cookies, not advertising cookies/i);
  });

  test('the no-advertising-trackers statement is preserved', () => {
    assert.match(prose, /no third-party advertising trackers on OneShetland/i);
  });

  test('no legal basis, retention rule or controller conclusion was invented here', () => {
    assert.ok(!/legitimate interest|legal basis|data controller|processor|GDPR Article/i.test(prose),
      'this section states observed facts; the lawful-basis section is elsewhere and unchanged');
  });
});

/* ── 5. Nothing technical moved ─────────────────────────────────────────── */

describe('this was a wording change only', () => {
  test('the consent banner is untouched', () => {
    const banner = read('components/analytics/ConsentBanner.tsx');
    assert.match(banner, /os_analytics_consent/);
    assert.ok(!/stripe/i.test(banner), 'the banner does not know about Stripe, and should not');
  });

  test('the Stripe loader boundary from W3A still holds', () => {
    assert.ok(!/from "@\/lib\/stripe"/.test(read('components/wallet/ChargeApprovalListener.tsx')));
    assert.ok(!/^\s*import\s/m.test(read('lib/currency.ts')));
    assert.match(read('lib/stripe.ts'), /export function getStripe/);
  });

  test('the analytics consent gate still precedes any identifier', () => {
    const src = read('lib/analytics.ts');
    const fn = src.slice(src.indexOf('export function track('));
    assert.ok(fn.indexOf('getAnalyticsConsent()') < fn.indexOf('anonId()'));
  });
});
