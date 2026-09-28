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

describe('app/auth/confirm.tsx no longer waits on Linking.useURL() and cannot hang', () => {
  // Superseded design: this screen used to wait on Linking.useURL() to read
  // a #access_token=… fragment off its own link — a mechanism now proven
  // unreachable (nothing in either repo constructs this link with a
  // fragment any more) and actively broken on a warm app resume, where
  // Expo Router's own linking listener consumes the one native "url" event
  // before this screen's own hook ever subscribes, leaving `url` null
  // forever. It now routes to sign-in unconditionally, with nothing to wait
  // on and therefore nothing that can hang.
  test('Linking.useURL() is gone — nothing left that can return null forever', () => {
    assert.doesNotMatch(mobileConfirm, /Linking\.useURL\(\)/);
    assert.doesNotMatch(mobileConfirm, /import \* as Linking from 'expo-linking'/);
  });

  test('no fragment/token parsing remains — parseFragment, access_token and refresh_token are gone', () => {
    assert.doesNotMatch(mobileConfirm, /parseFragment/);
    assert.doesNotMatch(mobileConfirm, /access_token/);
    assert.doesNotMatch(mobileConfirm, /refresh_token/);
    assert.doesNotMatch(mobileConfirm, /setSession/);
  });

  test('the effect is gated on nothing but mount — runs exactly once, unconditionally', () => {
    assert.match(mobileConfirm, /useEffect\(\(\) => \{\s*const dest = sanitizeNext\(next\);/);
    // An empty dependency array — no `handled`/`url` guard reintroduced.
    assert.match(mobileConfirm, /\}, \[\]\);/);
    assert.doesNotMatch(mobileConfirm, /if \(handled \|\| !url\) return;/);
  });

  test('it routes straight to sign-in, with next sanitised the same way the rest of the app does', () => {
    assert.match(mobileConfirm, /const dest = sanitizeNext\(next\);/);
    assert.match(mobileConfirm, /pathname: '\/\(auth\)\/sign-in' as const,/);
    assert.match(mobileConfirm, /params: \{ \.\.\.\(dest \? \{ next: dest \} : \{\}\), confirmed: '1' \}/);
  });

  test('no auth token of any kind is read, held, or forwarded by this screen', () => {
    assert.doesNotMatch(mobileConfirm, /token/i);
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
