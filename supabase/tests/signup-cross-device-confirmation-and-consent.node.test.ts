/**
 * signup-cross-device-confirmation-and-consent.node.test.ts
 *
 * Two launch blockers fixed together:
 *
 * A. Mobile's confirmation email used to redirect to a bare
 *    oneshetland-fetch://auth/confirm scheme, which dead-ends on any device
 *    that isn't running the app (about:blank on a laptop) — even though the
 *    account confirms correctly server-side regardless. It now goes through
 *    the same HTTPS callback web already uses, landing on a real
 *    oneshetland.com page that offers "Open OneShetland" — a plain link
 *    carrying no session credentials — with app/auth/confirm.tsx's existing
 *    token-less fallback (routes to sign-in) handling the return leg
 *    unchanged.
 *
 * B. Mobile signup never had an affirmative 18+/Terms/Privacy checkbox, yet
 *    unconditionally logged terms.accepted/privacy.accepted/age.confirmed on
 *    every successful signup. It now has the same required checkbox web has,
 *    and the compliance calls are structurally unreachable unless it was
 *    ticked (the validation gate returns before any of that code, including
 *    the Turnstile challenge and signUp() call, can run).
 *
 * SAFETY
 * Source-level assertions only, across both repos. No signup, no email, no
 * Turnstile call, no Supabase Auth call is made.
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
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

const authContext   = code(read('context/AuthContext.tsx'));
const authRedirect  = code(read('lib/auth-redirect.ts'));
const mobileSignUp  = code(read('app/(auth)/sign-up.tsx'));
const mobileConfirm = code(read('app/auth/confirm.tsx'));
const mobileConfirmRaw = read('app/auth/confirm.tsx'); // comments intact, for the one doc-comment check

const webCallback   = code(web('app/auth/callback/route.ts'));
const webConfirmed  = code(readFileSync(join(WEB_ROOT, 'app/auth/confirmed/page.tsx'), 'utf8'));
const webRedirect   = code(web('lib/redirect.ts'));

/* ── 1. HTTPS, not a bare custom scheme ───────────────────────────────────── */

describe('mobile emailRedirectTo is HTTPS, never a bare custom scheme', () => {
  test('emailConfirmationRedirectTo builds an https://oneshetland.com URL', () => {
    assert.match(authRedirect, /return `https:\/\/oneshetland\.com\/auth\/callback\?next=/);
    assert.doesNotMatch(authRedirect, /oneshetland-fetch:\/\/auth\/confirm(?!\S)/,
      'the redirect builder itself must never emit the bare app-scheme URL');
  });

  test('AuthContext.signUp uses the shared builder, not an inline scheme URL', () => {
    assert.match(authContext, /const emailRedirectTo = emailConfirmationRedirectTo\(next\);/);
    assert.doesNotMatch(authContext, /oneshetland-fetch:\/\/auth\/confirm\?next=\$\{encodeURIComponent/,
      'must not have reverted to constructing the bare scheme inline');
  });

  test('the resend-confirmation path uses the same HTTPS builder, not the old scheme', () => {
    assert.match(mobileSignUp, /emailRedirectTo: emailConfirmationRedirectTo\(next\)/);
  });
});

/* ── 2 & 5. Cross-device confirmation lands on a valid page ──────────────── */

describe('confirmation resolves correctly from any device', () => {
  test('the web callback still verifies server-side via token_hash — no browser-held state required', () => {
    assert.match(webCallback, /if \(tokenHash && type\) \{/);
    assert.match(webCallback, /sb\.auth\.verifyOtp\(\{ type, token_hash: tokenHash \}\)/);
  });

  test('a successful verification still redirects to the caller-supplied next, unchanged', () => {
    assert.match(webCallback, /return NextResponse\.redirect\(`\$\{origin\}\$\{next\}`\);/);
  });

  test('/auth/confirmed exists as a real page, not a 404, for the app-originated destination', () => {
    assert.match(webConfirmed, /export default function ConfirmedPage/);
    assert.match(webConfirmed, /You&apos;re confirmed/);
  });

  test('safeNext still rejects anything that is not an internal path — the destination cannot be hijacked', () => {
    assert.match(webRedirect, /if \(!next\.startsWith\("\/"\)\) return fallback;/);
    assert.match(webRedirect, /if \(next\.startsWith\("\/\/"\) \|\| next\.startsWith\("\/\\\\"\)\) return fallback;/);
  });
});

/* ── 3. No token in any query string ──────────────────────────────────────── */

describe('no access_token or refresh_token is ever exposed in a URL', () => {
  const files: [string, string][] = [
    ['lib/auth-redirect.ts', authRedirect],
    ['context/AuthContext.tsx', authContext],
    ['app/(auth)/sign-up.tsx', mobileSignUp],
    ['web app/auth/confirmed/page.tsx', webConfirmed],
    ['web app/auth/callback/route.ts', webCallback],
  ];
  for (const [label, src] of files) {
    test(`${label} never puts access_token/refresh_token in a URL`, () => {
      assert.doesNotMatch(src, /[?&]access_token=/, `${label} must not build a URL carrying access_token`);
      assert.doesNotMatch(src, /[?&]refresh_token=/, `${label} must not build a URL carrying refresh_token`);
    });
  }

  test('the web callback establishes a session via server-side cookies, never by handing tokens back in a redirect URL', () => {
    // Both success branches redirect to a plain internal path — neither ever
    // appends the session it just created onto the Location header.
    const successRedirects = webCallback.match(/NextResponse\.redirect\(`\$\{origin\}\$\{next\}`\);/g) ?? [];
    assert.ok(successRedirects.length >= 2, 'both token_hash and code success paths must redirect the same plain way');
  });

  test('/auth/confirmed builds the app link from nothing but a sanitised path — no session data', () => {
    assert.match(webConfirmed, /const appLink = `oneshetland-fetch:\/\/auth\/confirm\$\{/);
    assert.doesNotMatch(webConfirmed, /token|session|access_token|refresh_token/i);
  });
});

/* ── 4. Same-device app-return path is intact ─────────────────────────────── */

describe('same-device confirmation still works exactly as before', () => {
  test('app/auth/confirm.tsx keeps its dual path: tokens present → sign in; tokens absent → sign-in screen', () => {
    assert.match(mobileConfirm, /const \{ access_token, refresh_token \} = parseFragment\(url\);/);
    assert.match(mobileConfirm, /supabase\.auth[\s\S]{0,20}\.setSession\(\{ access_token, refresh_token \}\)/);
    // The token-less fallback: the effect ends by falling through to the
    // sign-in redirect when no tokens were on the link.
    assert.match(mobileConfirm, /router\.replace\(toSignIn\);/);
    assert.match(mobileConfirmRaw, /No tokens on the link — the account is confirmed, but we still need them/);
  });

  test('the hosted /auth/confirmed page always offers a plain, token-less deep link back into the app', () => {
    assert.match(webConfirmed, /href=\{appLink\}/);
    assert.match(webConfirmed, /Open OneShetland/);
  });
});

/* ── 6, 7, 8, 9, 10. Mobile consent checkbox ──────────────────────────────── */

describe('mobile now has a required 18+/Terms/Privacy checkbox, matching web', () => {
  test('an agree state exists, unticked by default', () => {
    assert.match(mobileSignUp, /const \[agree, setAgree\] = useState\(false\)/);
  });

  test('the checkbox carries the required wording and working Terms/Privacy links', () => {
    assert.match(mobileSignUp, /I'm 18 or over and accept the/);
    assert.match(mobileSignUp, /Linking\.openURL\('https:\/\/oneshetland\.com\/terms'\)/);
    assert.match(mobileSignUp, /Linking\.openURL\('https:\/\/oneshetland\.com\/privacy'\)/);
  });

  test('signup is refused before anything else runs when unchecked', () => {
    const i = mobileSignUp.indexOf('async function handleSignUp');
    const body = mobileSignUp.slice(i);
    const agreeCheckIdx = body.indexOf("if (!agree)");
    const turnstileIdx  = body.indexOf('getTurnstileToken()');
    const signUpIdx     = body.indexOf('await signUp(');
    assert.ok(agreeCheckIdx !== -1 && agreeCheckIdx < turnstileIdx && turnstileIdx < signUpIdx,
      'the agree check must run before the Turnstile challenge and before signUp()');
  });

  test('the Create account button is disabled while unchecked', () => {
    assert.match(mobileSignUp, /label="Create account"[\s\S]{0,150}disabled=\{!agree\}/);
  });

  test('compliance events are structurally unreachable unless agree was true', () => {
    const i = mobileSignUp.indexOf('async function handleSignUp');
    const body = mobileSignUp.slice(i, mobileSignUp.indexOf('// Resend the confirmation email'));
    const agreeReturnIdx = body.indexOf('if (!agree) { setError(');
    const firstLogIdx = body.indexOf("logCompliance({ eventType: 'terms.accepted'");
    assert.ok(agreeReturnIdx !== -1 && agreeReturnIdx < firstLogIdx,
      'the unchecked-agree early return must appear before any logCompliance call in source order');
  });

  test('compliance events fire only inside the post-signUp success branch, not unconditionally', () => {
    assert.match(mobileSignUp, /if \(authError\) \{\s*setError\(authError\);\s*\} else \{[\s\S]{0,50}logCompliance/);
  });

  test('marketing consent stays a fully independent, still-optional control', () => {
    assert.match(mobileSignUp, /const \[marketingOptIn, setMarketingOptIn\] = useState\(false\)/);
    // Not part of the required-agree gate:
    const gateLine = mobileSignUp.match(/if \(!agree\) \{ setError\([^;]+; \}/)?.[0] ?? '';
    assert.doesNotMatch(gateLine, /marketingOptIn/);
    // Still passed through to signUp() as its own independent argument, unchanged:
    assert.match(mobileSignUp, /marketingOptIn,\s*\n\s*next,/);
    assert.match(authContext, /marketing_opt_in: marketingOptIn/);
  });
});

/* ── 11. Turnstile is untouched ────────────────────────────────────────────── */

describe('the Turnstile flow added earlier is unaffected', () => {
  test('getTurnstileToken() still runs, still before signUp(), still with no bypass on failure', () => {
    const i = mobileSignUp.indexOf('async function handleSignUp');
    const body = mobileSignUp.slice(i);
    const tokenIdx = body.indexOf('await getTurnstileToken()');
    const signUpIdx = body.indexOf('await signUp(');
    assert.ok(tokenIdx !== -1 && tokenIdx < signUpIdx);
    assert.match(mobileSignUp, /if \(!turnstile\.ok\) \{/);
  });

  test('signUp still requires captchaToken as a parameter, forwarded to Supabase unchanged', () => {
    assert.match(authContext, /async function signUp\(email: string, password: string, fullName: string, captchaToken: string,/);
    assert.match(authContext, /captchaToken,/);
  });
});
