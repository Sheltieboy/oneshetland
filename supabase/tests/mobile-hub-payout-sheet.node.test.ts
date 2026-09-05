/**
 * mobile-hub-payout-sheet.node.test.ts — Stripe onboarding without leaving the app.
 *
 * WHAT WAS WRONG
 *
 * "Set up payouts" called Linking.openURL, which hands the user to full
 * external Safari. They leave OneShetland, complete a bank onboarding in a
 * browser that looks like nothing to do with us, and have to find their way
 * back. The app already presents Stripe Connect onboarding as an in-app sheet
 * for BUSINESS accounts (local-business-dashboard) using expo-web-browser; hubs
 * simply never got the same treatment.
 *
 * WHAT IS ASSERTED
 *   · both hub payout entry points open the in-app browser sheet
 *   · neither uses Linking.openURL, so full Safari is never launched
 *   · the presentation is a sheet, matching the business onboarding already shipped
 *   · readiness is re-read from the database AFTER the sheet closes — closing a
 *     sheet is not evidence that Stripe finished
 *   · a fresh account link is minted per attempt, which is how an expired
 *     Stripe onboarding link is handled
 *   · stripe_account_id reaches no client file
 *   · the Stripe return deep-link still lands somewhere that re-reads readiness
 *
 * WHY NOT openAuthSessionAsync
 *
 * It would auto-dismiss on the return redirect, but on iOS it shows a system
 * consent alert about signing in — wrong words for a payout setup — and this
 * app already has a proven sheet pattern. Closing by hand plus an explicit
 * re-read is the smaller change and cannot report success that did not happen.
 *
 * SAFETY
 * Source inspection of mobile files and one edge function. No database, no
 * network, no writes, no Stripe.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAYOUTS = join(REPO_ROOT, 'app/hub-payouts.tsx');
const TIERS = join(REPO_ROOT, 'app/hub-membership-types.tsx');
const API = join(REPO_ROOT, 'lib/hubs-api.ts');
const NOTICE = join(REPO_ROOT, 'lib/hub-payout-notice.ts');
const REDIRECT = join(REPO_ROOT, 'supabase/functions/connect-redirect/index.ts');
const DASHBOARD = join(REPO_ROOT, 'app/local-business-dashboard.tsx');

const src = (p: string) => readFileSync(p, 'utf8');
const code = (p: string) => src(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const SCREENS: [string, string][] = [['hub-payouts', PAYOUTS], ['hub-membership-types', TIERS]];

describe('the onboarding opens inside the app', () => {
  for (const [name, file] of SCREENS) {
    test(`${name} uses the in-app browser, not external Safari`, () => {
      const c = code(file);
      assert.match(c, /import \* as WebBrowser from 'expo-web-browser'/, 'the in-app browser is not imported');
      assert.match(c, /WebBrowser\.openBrowserAsync\(url, \{/);
      assert.doesNotMatch(c, /Linking\.openURL/, 'this hands the user to full Safari');
    });

    test(`${name} presents it as a sheet`, () => {
      const c = code(file);
      assert.match(c, /presentationStyle:\s*WebBrowser\.WebBrowserPresentationStyle\.PAGE_SHEET/);
      assert.match(c, /dismissButtonStyle:\s*'close'/);
    });
  }

  test('it is the same mechanism the business onboarding already ships', () => {
    const d = code(DASHBOARD);
    assert.match(d, /WebBrowser\.openBrowserAsync/);
    assert.match(d, /WebBrowserPresentationStyle\.PAGE_SHEET/);
  });

  test('no dependency was added for it', () => {
    const pkg = JSON.parse(src(join(REPO_ROOT, 'package.json'))) as { dependencies: Record<string, string> };
    assert.ok(pkg.dependencies['expo-web-browser'], 'expo-web-browser is not a dependency');
    for (const added of ['react-native-webview', 'react-native-inappbrowser-reborn']) {
      assert.equal(pkg.dependencies[added], undefined, `${added} must not be introduced`);
    }
  });
});

describe('what happens when the sheet closes', () => {
  for (const [name, file] of SCREENS) {
    test(`${name} re-reads readiness afterwards`, () => {
      const c = code(file);
      const open = c.indexOf('WebBrowser.openBrowserAsync');
      const refresh = c.indexOf('await load();', open);
      assert.notEqual(open, -1);
      assert.notEqual(refresh, -1, 'nothing refreshes after the browser closes');
      assert.ok(refresh > open, 'the refresh must come AFTER the sheet, not before');
    });

    test(`${name} does not assume closing meant success`, () => {
      const c = code(file);
      // No optimistic local flip: readiness only ever comes from the server read.
      assert.doesNotMatch(c, /setPayoutReady\(true\)/, 'readiness was assumed rather than read');
      assert.doesNotMatch(c, /setReady\(true\)/);
    });
  }

  test('incomplete onboarding therefore stays not-ready', () => {
    // fetchHubPayoutReady fails closed and returns the database's answer.
    const c = code(API);
    const fn = c.slice(c.indexOf('export async function fetchHubPayoutReady'));
    const body = fn.slice(0, fn.indexOf('\n}') + 2);
    assert.match(body, /if \(error\) return false;/);
    assert.match(body, /return data === true;/);
  });

  test('and a completed one can render the ready state', () => {
    const c = code(PAYOUTS);
    assert.match(c, /hubPayoutNotice\(ready\)/);
    assert.match(code(NOTICE), /Payouts ready ✓/);
  });
});

describe('expired Stripe links, and where the return lands', () => {
  for (const [name, file] of SCREENS) {
    test(`${name} mints a fresh account link per attempt`, () => {
      const c = code(file);
      const handler = c.slice(c.indexOf('const setUpPayouts'), c.indexOf('WebBrowser.openBrowserAsync'));
      assert.match(handler, /await createHubOnboardingLink\(id\)/,
        'the link must be created inside the handler, so an expired one is replaced by tapping again');
    });
  }

  test('the return redirect still deep-links into a screen that re-reads readiness', () => {
    const r = code(REDIRECT);
    assert.match(r, /oneshetland-fetch:\/\/hub-membership-types\?id=\$\{hubId\}&connect=\$\{retry \? 'refresh' : 'return'\}/,
      'the hub return deep-link changed');
    const t = code(TIERS);
    assert.match(t, /useFocusEffect\(useCallback\(\(\) => \{ load\(\); \}, \[load\]\)\)/);
    assert.match(t, /fetchHubPayoutReady\(id\)/);
  });

  test('the edge functions and Stripe wiring were not touched', () => {
    const r = code(REDIRECT);
    assert.match(r, /'Location': appScheme/, 'the redirect mechanism changed');
    const onboard = code(join(REPO_ROOT, 'supabase/functions/hub-onboard/index.ts'));
    assert.match(onboard, /account_links/, 'hub-onboard no longer creates an account link');
    assert.match(onboard, /refresh_url:/);
    assert.match(onboard, /return_url:/);
  });
});

describe('nothing the client may not have', () => {
  test('stripe_account_id reaches no client file', () => {
    for (const f of [PAYOUTS, TIERS, API, NOTICE]) {
      assert.doesNotMatch(code(f), /stripe_account_id/,
        `${f.split('/').pop()} names a column granted to no client role`);
    }
  });

  test("select('*') is still not used on hubs", () => {
    assert.doesNotMatch(code(API), /from\('hubs'\)\.select\('\*'\)/);
  });
});
