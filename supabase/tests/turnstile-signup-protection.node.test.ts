/**
 * turnstile-signup-protection.node.test.ts — client-side readiness for
 * Cloudflare Turnstile on both signup surfaces, ahead of Supabase CAPTCHA
 * enforcement being turned on.
 *
 * WHAT THIS PROVES
 *
 * Neither signup call site can reach Stripe/Supabase without a real,
 * freshly-obtained Turnstile token; neither ever falls back to an
 * unprotected call; a spent/expired/failed token forces a fresh challenge
 * before retry; and existing validation (name, email, password, ToS) is
 * untouched. Also proves the Turnstile SECRET never appears anywhere in
 * client-bundled code — only the public site key, read from an env var.
 *
 * SAFETY
 * Source-level assertions only. No Turnstile call, no Supabase Auth call, no
 * signup is made. Nothing here can create a user or send an email.
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

const webSignUp        = code(web('app/sign-up/page.tsx'));
const webTurnstileLib  = code(web('lib/turnstile.ts'));
const webTurnstileUi   = code(readFileSync(join(WEB_ROOT, 'components/ui/Turnstile.tsx'), 'utf8'));
const webChallengePage = code(web('app/mobile-turnstile-challenge/page.tsx'));

const mobileAuthContext = code(read('context/AuthContext.tsx'));
const mobileSignUp      = code(read('app/(auth)/sign-up.tsx'));
const mobileTurnstileLib = code(read('lib/turnstile.ts'));
const mobileCallback    = code(read('app/turnstile-callback.tsx'));

/* ── 1 & 2. Web: token required to submit ─────────────────────────────────── */

describe('web signup includes and requires a real captchaToken', () => {
  test('signUp() is called with options.captchaToken', () => {
    assert.match(webSignUp, /captchaToken,\s*\n\s*data:\s*\{/);
  });

  test('captchaToken comes from Turnstile state, not a placeholder', () => {
    assert.match(webSignUp, /const \[captchaToken, setCaptchaToken\] = useState<string \| null>\(null\)/);
    assert.match(webSignUp, /<Turnstile[\s\S]{0,60}onToken=\{setCaptchaToken\}/);
  });

  test('the submit path refuses to proceed without a token, before calling Supabase', () => {
    const i = webSignUp.indexOf('async function submit');
    const before = webSignUp.slice(i, webSignUp.indexOf('sb.auth.signUp'));
    assert.match(before, /if \(!captchaToken\) return setError\(/,
      'must return before signUp() is ever called when no token is present');
  });

  test('the submit button is disabled without a token — no client-only bypass of the UI gate', () => {
    assert.match(webSignUp, /disabled=\{busy \|\| !agree \|\| !captchaToken\}/);
  });
});

/* ── 3. Expiry/failure resets correctly ───────────────────────────────────── */

describe('a spent, expired or failed token forces a fresh challenge', () => {
  test('the widget clears its own token on expiry, error and timeout — never keeps a stale one alive', () => {
    assert.match(webTurnstileUi, /"expired-callback":\s*\(\)\s*=>\s*onToken\(null\)/);
    assert.match(webTurnstileUi, /"timeout-callback":\s*\(\)\s*=>\s*onToken\(null\)/);
    assert.match(webTurnstileUi, /"error-callback":\s*\(\)\s*=>\s*\{[\s\S]{0,60}onToken\(null\)/);
  });

  test('the widget exposes an imperative reset, and the sign-up page calls it after every attempt', () => {
    assert.match(webTurnstileUi, /useImperativeHandle\(ref, \(\) => \(\{\s*reset: \(\) => \{/);
    assert.match(webSignUp, /turnstileRef\.current\?\.reset\(\);/);
    // Must run for BOTH outcomes — a token is single-use regardless of
    // whether Supabase accepted it — so the reset call must sit before the
    // error/success branch, not inside only one of them.
    const resetIdx = webSignUp.indexOf('turnstileRef.current?.reset();');
    const errorBranchIdx = webSignUp.indexOf('if (error) {');
    assert.ok(resetIdx !== -1 && resetIdx < errorBranchIdx,
      'reset must happen before branching on the signUp result, not only on failure');
  });

  test('a widget load/render failure surfaces a clear user-facing error, not silent submission', () => {
    assert.match(webTurnstileUi, /Couldn&apos;t load the verification check/);
    assert.match(webSignUp, /onError=\{\(\) => setError\(/);
  });
});

/* ── 4 & 5. Mobile: token required, no silent bypass ──────────────────────── */

describe('mobile signup includes and requires a real captchaToken', () => {
  test('getTurnstileToken() runs before signUp() is ever called', () => {
    const i = mobileSignUp.indexOf('async function handleSignUp');
    const body = mobileSignUp.slice(i);
    const tokenIdx = body.indexOf('await getTurnstileToken()');
    const signUpIdx = body.indexOf('await signUp(');
    assert.ok(tokenIdx !== -1 && signUpIdx !== -1 && tokenIdx < signUpIdx,
      'the Turnstile challenge must run and resolve before signUp() is called');
  });

  test('a failed/cancelled challenge returns before signUp() — no fallback path reaches it', () => {
    const i = mobileSignUp.indexOf('const turnstile = await getTurnstileToken();');
    const block = mobileSignUp.slice(i, mobileSignUp.indexOf('await signUp('));
    assert.match(block, /if \(!turnstile\.ok\) \{/);
    assert.match(block, /return;/);
  });

  test('signUp() receives the real token, not a placeholder or empty string', () => {
    assert.match(mobileSignUp, /turnstile\.token,/);
  });

  test('AuthContext.signUp forwards captchaToken to Supabase, as a required (non-optional) parameter', () => {
    assert.match(mobileAuthContext, /async function signUp\(email: string, password: string, fullName: string, captchaToken: string,/);
    assert.match(mobileAuthContext, /options:\s*\{[\s\S]{0,40}captchaToken,[\s\S]{0,60}data:\s*\{\s*full_name: fullName/);
  });

  test('getTurnstileToken() itself never fabricates a token — every branch is an explicit ok/fail result', () => {
    assert.doesNotMatch(mobileTurnstileLib, /ok:\s*true(?![\s\S]{0,20}token)/);
    assert.match(mobileTurnstileLib, /if \(result\.type !== 'success' \|\| !result\.url\)/);
    assert.match(mobileTurnstileLib, /if \(!token\) return \{ ok: false/);
  });

  test('the defensive fallback route does no confirmation/financial work — pure navigation, like its siblings', () => {
    assert.doesNotMatch(mobileCallback, /supabase\.|fetch\(|invoke\(/);
    assert.match(mobileCallback, /router\.canGoBack\(\)/);
  });
});

/* ── 6. Existing validation is untouched ──────────────────────────────────── */

describe('existing signup validation is unchanged on both clients', () => {
  test('web: name, password length, password match, and ToS agreement checks are all still present', () => {
    assert.match(webSignUp, /if \(!fullName\.trim\(\)\) return setError\("Please enter your name\."\);/);
    assert.match(webSignUp, /if \(password\.length < 8\) return setError\("Password must be at least 8 characters\."\);/);
    assert.match(webSignUp, /if \(password !== confirm\) return setError\("Passwords don't match\."\);/);
    assert.match(webSignUp, /if \(!agree\) return setError\("Please confirm you're 18\+ and accept the terms\."\);/);
  });

  test('mobile: name, email, password length, and password-match checks are all still present', () => {
    assert.match(mobileSignUp, /if \(!fullName\.trim\(\)\) \{ setError\('Please enter your full name\.'\); return; \}/);
    assert.match(mobileSignUp, /if \(!email\.trim\(\)\) \{ setError\('Please enter your email address\.'\); return; \}/);
    assert.match(mobileSignUp, /if \(password\.length < 8\) \{ setError\('Password must be at least 8 characters\.'\); return; \}/);
    assert.match(mobileSignUp, /if \(password !== confirmPassword\) \{ setError\('Passwords do not match\.'\); return; \}/);
  });

  test('redirect/next behaviour is unchanged on both clients', () => {
    assert.match(webSignUp, /emailRedirectTo: `\$\{window\.location\.origin\}\/auth\/callback\?next=/);
    assert.match(mobileAuthContext, /oneshetland-fetch:\/\/auth\/confirm/);
  });
});

/* ── 7. No secret anywhere client-side ────────────────────────────────────── */

describe('the Turnstile secret never appears in any client-reachable file', () => {
  const files: [string, string][] = [
    ['web sign-up page', webSignUp],
    ['web turnstile lib', webTurnstileLib],
    ['web turnstile widget', webTurnstileUi],
    ['web mobile-challenge page', webChallengePage],
    ['mobile AuthContext', mobileAuthContext],
    ['mobile sign-up screen', mobileSignUp],
    ['mobile turnstile lib', mobileTurnstileLib],
    ['mobile turnstile-callback screen', mobileCallback],
  ];

  for (const [label, src] of files) {
    test(`${label} references only the public site key, never a secret`, () => {
      assert.doesNotMatch(src, /TURNSTILE_SECRET/i, `${label} must never reference a Turnstile secret env var`);
      assert.doesNotMatch(src, /turnstile[_-]?secret/i, `${label} must never name a Turnstile secret`);
      // A bare, hardcoded Cloudflare-shaped key literal (both site and secret
      // keys share the 0x4AAAAAAA... prefix) must never appear as a string
      // literal — only ever read from an env var.
      assert.doesNotMatch(src, /['"]0x4AAAAAAA[A-Za-z0-9_-]+['"]/,
        `${label} must never hardcode a literal Turnstile key`);
    });
  }

  test('the only Turnstile env var referenced anywhere is the NEXT_PUBLIC site key', () => {
    for (const src of [webTurnstileLib, webSignUp, webChallengePage]) {
      const envRefs = src.match(/process\.env\.[A-Z0-9_]*TURNSTILE[A-Z0-9_]*/g) ?? [];
      for (const ref of envRefs) {
        assert.equal(ref, 'process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY',
          `unexpected Turnstile env reference: ${ref}`);
      }
    }
    // Mobile never references a Turnstile env var at all — the widget and its
    // site key live entirely on the hosted web page, not in the app.
    for (const src of [mobileTurnstileLib, mobileSignUp, mobileAuthContext, mobileCallback]) {
      assert.doesNotMatch(src, /TURNSTILE/, 'mobile code must not reference Turnstile config directly');
    }
  });
});
