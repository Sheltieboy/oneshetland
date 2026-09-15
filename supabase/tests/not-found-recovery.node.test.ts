/**
 * not-found-recovery.node.test.ts
 *
 * A defensive recovery layer for any URL Expo Router fails to match — proven
 * live once, when a confirmed-but-not-yet-signed-in device showed a raw
 * "Unmatched Route" screen for `oneshetland-fetch:///` (empty authority and
 * path) instead of the `oneshetland-fetch://auth/confirm` the app actually
 * constructs. Tapping "Go back" recovered correctly to /onboarding on its
 * own, proving app/_layout.tsx's session/profile-aware routing already knows
 * what to do — it just needs a real, registered route to run from instead of
 * a dead end.
 *
 * WHAT THIS IS NOT
 * This does not fix, explain, or claim to explain what produced the empty
 * URL. That remains unconfirmed. This is purely: eliminate the dead-end
 * screen, land on "/", let the existing router decide — nothing more.
 *
 * SAFETY
 * Source-level assertions only. No Supabase Auth call, no signup, no
 * navigation, no OTA. Nothing here can create a user or mutate production.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const exists = (p: string) => existsSync(join(REPO_ROOT, p));
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

const notFoundPath = 'app/+not-found.tsx';
const notFound = code(read(notFoundPath));
const layout = code(read('app/_layout.tsx'));
const authConfirm = code(read('app/auth/confirm.tsx'));
const onboarding = code(read('app/onboarding.tsx'));
const paymentReturn = read('app/payment-return.tsx'); // exact bytes
const turnstileLib = code(read('lib/turnstile.ts'));
const turnstileCallback = code(read('app/turnstile-callback.tsx'));

/* ── 1, 2. The file exists and routes to "/" ──────────────────────────────── */

describe('app/+not-found.tsx exists and routes safely to "/"', () => {
  test('the file exists at the Expo Router catch-all convention path', () => {
    assert.ok(exists(notFoundPath));
  });

  test('it calls router.replace with the root path, on mount', () => {
    assert.match(notFound, /router\.replace\('\/'\)/);
    assert.match(notFound, /useEffect\(\(\) => \{\s*router\.replace\('\/'\);/);
    // Empty dependency array — runs exactly once, unconditionally.
    assert.match(notFound, /\}, \[\]\);/);
  });

  test('it is registered as a real Stack screen', () => {
    assert.match(layout, /<Stack\.Screen name="\+not-found" \/>/);
  });
});

/* ── 3, 4, 5. No auth/session logic, no token parsing, no link reconstruction ── */

describe('the screen decides nothing itself — it only hands off to a real route', () => {
  test('no session, profile, or auth-context import of any kind', () => {
    assert.doesNotMatch(notFound, /useAuth|AuthContext|session|profile/i);
  });

  test('no Supabase import or call', () => {
    assert.doesNotMatch(notFound, /supabase/i);
  });

  test('no access_token or refresh_token handling', () => {
    assert.doesNotMatch(notFound, /access_token|refresh_token/);
  });

  test('no reading of the failed URL, search params, or a next/deep-link destination', () => {
    assert.doesNotMatch(notFound, /useLocalSearchParams|useGlobalSearchParams|useSegments|usePathname/);
    assert.doesNotMatch(notFound, /\bnext\b/);
    assert.doesNotMatch(notFound, /sanitizeNext/);
  });

  test('it is a short, minimal file — a recovery hand-off, not a second router', () => {
    const lineCount = notFound.split('\n').filter(l => l.trim()).length;
    assert.ok(lineCount < 25, `expected a minimal screen, got ${lineCount} non-empty lines`);
  });
});

/* ── 6, 7, 8, 9. Nothing else this task must not touch was touched ────────── */

describe('auth confirmation, onboarding, payment-return and Turnstile are unchanged', () => {
  test('app/auth/confirm.tsx: unchanged shape — still routes straight to sign-in, no waiting', () => {
    assert.match(authConfirm, /pathname: '\/\(auth\)\/sign-in' as const/);
    assert.doesNotMatch(authConfirm, /access_token/);
    assert.doesNotMatch(authConfirm, /Linking\.useURL/);
  });

  test('the onboarding routing gate in app/_layout.tsx is unchanged in shape', () => {
    assert.match(layout, /if \(profile && !profile\.onboarding_completed_at && !onOnboardingScreen && !isInfrastructureRoute\) \{/);
    assert.match(layout, /const onOnboardingScreen = \(segments as string\[\]\)\[0\] === 'onboarding';/);
  });

  test('app/onboarding.tsx: unchanged — still requires display name + audience, avatar still optional', () => {
    assert.match(onboarding, /if \(!displayName\.trim\(\)\) \{/);
    assert.match(onboarding, /if \(!audience\) \{/);
    assert.match(onboarding, /onboarding_completed_at:\s*new Date\(\)\.toISOString\(\)/);
  });

  test('app/payment-return.tsx: byte-identical in behaviour — still pure navigation, no financial work', () => {
    assert.doesNotMatch(paymentReturn, /supabase\.|fetch\(|invoke\(/);
    assert.match(paymentReturn, /router\.canGoBack\(\)/);
    assert.match(paymentReturn, /router\.replace\('\/\(tabs\)'\)/);
  });

  test('Turnstile: getTurnstileToken() and its callback screen are unchanged', () => {
    assert.match(turnstileLib, /export async function getTurnstileToken\(\): Promise<TurnstileResult> \{/);
    assert.doesNotMatch(turnstileCallback, /supabase\.|fetch\(|invoke\(/);
  });

  test('the Stripe urlScheme line is still present, untouched', () => {
    assert.match(layout, /urlScheme="oneshetland-fetch"/);
  });
});
