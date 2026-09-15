/**
 * auth-captcha-full-coverage.node.test.ts
 *
 * The remaining CAPTCHA-gated flows the earlier signup-only Turnstile work
 * didn't cover — proven by the audit that preceded this: a real mobile
 * sign-in failed with "captcha protection: request disallowed (no
 * captcha_token found)" once Supabase Attack Protection was turned on,
 * because signInWithPassword() never passed a token. The same gap existed
 * for resend (both platforms) and mobile's own password-reset request.
 *
 * Five call sites, one fix pattern, reusing exactly what signup already
 * shipped:
 *   - web:    the existing <Turnstile> component + ref/reset pattern
 *   - mobile: the existing, already-generic getTurnstileToken() helper
 *
 * Everything NOT in that list — signUp() itself, verifyOtp/token_hash
 * confirmation and reset-verification, updateUser, session refresh,
 * getSession/getUser/onAuthStateChange, signOut — has no captchaToken option
 * in the SDK at all and is asserted here to be untouched.
 *
 * SAFETY
 * Source-level assertions only. No Turnstile call, no Supabase Auth call, no
 * sign-in/sign-up/reset is made. Nothing here can create a user, sign in, or
 * send an email. Supabase CAPTCHA enforcement stays OFF regardless of this
 * file — it asserts source shape, not live behaviour.
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

const authContext      = code(read('context/AuthContext.tsx'));
const mobileSignIn     = code(read('app/(auth)/sign-in.tsx'));
const mobileSignUp     = code(read('app/(auth)/sign-up.tsx'));
const mobileForgotPw   = code(read('app/(auth)/forgot-password.tsx'));
const mobileConfirm    = code(read('app/auth/confirm.tsx'));
const mobileTurnstileLib = code(read('lib/turnstile.ts'));

const webSignIn      = code(web('app/sign-in/page.tsx'));
const webResetPw     = code(web('app/reset-password/page.tsx'));
const webForgotPw    = code(web('app/forgot-password/page.tsx'));
const webCallback    = code(web('app/auth/callback/route.ts'));

/* ── 1 & 2. Mobile sign-in ─────────────────────────────────────────────────── */

describe('mobile sign-in requires a fresh Turnstile token', () => {
  test('AuthContext.signIn takes a captchaToken and forwards it to signInWithPassword', () => {
    assert.match(authContext, /async function signIn\(email: string, password: string, captchaToken: string\)/);
    assert.match(authContext, /signInWithPassword\(\{\s*email,\s*password,\s*options:\s*\{\s*captchaToken\s*\},?\s*\}\)/);
  });

  test('the sign-in screen obtains a token before calling signIn(), and never calls it without one', () => {
    const i = mobileSignIn.indexOf('async function handleSignIn');
    const body = mobileSignIn.slice(i);
    const tokenIdx = body.indexOf('await getTurnstileToken()');
    const signInIdx = body.indexOf('await signIn(');
    assert.ok(tokenIdx !== -1 && signInIdx !== -1 && tokenIdx < signInIdx,
      'the Turnstile challenge must run and resolve before signIn() is called');
  });

  test('a failed/cancelled challenge returns before signIn() — no unprotected fallback', () => {
    const i = mobileSignIn.indexOf('const turnstile = await getTurnstileToken();');
    const block = mobileSignIn.slice(i, mobileSignIn.indexOf('await signIn('));
    assert.match(block, /if \(!turnstile\.ok\) \{/);
    assert.match(block, /return;/);
  });

  test('signIn() receives the real token, not a placeholder', () => {
    assert.match(mobileSignIn, /await signIn\(email\.trim\(\)\.toLowerCase\(\), password, turnstile\.token\)/);
  });

  test('the sign-up screen\'s own sign-in check (handleCheckConfirmed) is protected the same way — it is the same signInWithPassword call', () => {
    const i = mobileSignUp.indexOf('async function handleCheckConfirmed');
    const body = mobileSignUp.slice(i);
    const tokenIdx = body.indexOf('await getTurnstileToken()');
    const signInIdx = body.indexOf('await signIn(');
    assert.ok(tokenIdx !== -1 && signInIdx !== -1 && tokenIdx < signInIdx);
    assert.match(body.slice(0, signInIdx), /if \(!turnstile\.ok\) \{[\s\S]{0,300}return;/);
  });
});

/* ── 3 & 4. Web sign-in ────────────────────────────────────────────────────── */

describe('web sign-in requires a fresh Turnstile token', () => {
  test('the Turnstile widget is rendered on the sign-in page, wired to captchaToken state', () => {
    assert.match(webSignIn, /const \[captchaToken, setCaptchaToken\] = useState<string \| null>\(null\)/);
    assert.match(webSignIn, /<Turnstile[\s\S]{0,60}onToken=\{setCaptchaToken\}/);
  });

  test('submit() refuses to call signInWithPassword without a token', () => {
    const i = webSignIn.indexOf('async function submit');
    const before = webSignIn.slice(i, webSignIn.indexOf('sb.auth.signInWithPassword'));
    assert.match(before, /if \(!captchaToken\) \{ setError\(/);
  });

  test('signInWithPassword is called with options.captchaToken', () => {
    assert.match(webSignIn, /sb\.auth\.signInWithPassword\(\{[\s\S]{0,120}options:\s*\{\s*captchaToken:\s*token\s*\}/);
  });

  test('the sign-in submit button is disabled without a token — no client-only bypass of the UI gate', () => {
    assert.match(webSignIn, /type="submit"\s*\n\s*disabled=\{busy \|\| !captchaToken\}/);
  });
});

/* ── 5 & 6. Resend confirmation, both platforms ───────────────────────────── */

describe('resend confirmation requires a fresh Turnstile token on both platforms', () => {
  test('mobile: handleResend obtains a token before resend(), and refuses to call it without one', () => {
    const i = mobileSignUp.indexOf('async function handleResend');
    const body = mobileSignUp.slice(i, mobileSignUp.indexOf('async function handleCheckConfirmed'));
    const tokenIdx = body.indexOf('await getTurnstileToken()');
    const resendIdx = body.indexOf('await supabase.auth.resend(');
    assert.ok(tokenIdx !== -1 && resendIdx !== -1 && tokenIdx < resendIdx);
    assert.match(body.slice(0, resendIdx), /if \(!turnstile\.ok\) \{[\s\S]{0,300}return;/);
  });

  test('mobile: resend() is called with the fresh token, not the original signup token', () => {
    assert.match(mobileSignUp, /options:\s*\{\s*captchaToken:\s*turnstile\.token,\s*\n\s*emailRedirectTo: emailConfirmationRedirectTo\(next\),/);
  });

  test('web: resendConfirmation() refuses to call resend() without a token', () => {
    const i = webSignIn.indexOf('async function resendConfirmation');
    const before = webSignIn.slice(i, webSignIn.indexOf('.auth.resend'));
    assert.match(before, /if \(!captchaToken\) \{ setError\(/);
  });

  test('web: resend() is called with options.captchaToken', () => {
    assert.match(webSignIn, /\.auth\.resend\(\{[\s\S]{0,150}options:\s*\{\s*captchaToken:\s*token,/);
  });

  test('web: the resend button is disabled without a token', () => {
    assert.match(webSignIn, /onClick=\{\(\) => void resendConfirmation\(\)\}\s*\n\s*disabled=\{resending \|\| !captchaToken\}/);
  });
});

/* ── 7. Mobile password-reset request ─────────────────────────────────────── */

describe('mobile password-reset request requires a fresh Turnstile token', () => {
  test('handleSend obtains a token before resetPasswordForEmail(), and refuses to call it without one', () => {
    const i = mobileForgotPw.indexOf('async function handleSend');
    const body = mobileForgotPw.slice(i);
    const tokenIdx = body.indexOf('await getTurnstileToken()');
    const resetIdx = body.indexOf('await supabase.auth.resetPasswordForEmail(');
    assert.ok(tokenIdx !== -1 && resetIdx !== -1 && tokenIdx < resetIdx);
    assert.match(body.slice(0, resetIdx), /if \(!turnstile\.ok\) \{[\s\S]{0,300}return;/);
  });

  test('resetPasswordForEmail is called with the token in its captchaToken option', () => {
    assert.match(mobileForgotPw, /resetPasswordForEmail\(\s*\n\s*email\.trim\(\)\.toLowerCase\(\),\s*\n\s*\{ redirectTo: RESET_REDIRECT, captchaToken: turnstile\.token \},/);
  });

  test('web\'s password-reset request is architecturally exempt and is untouched — it never reaches this method at all', () => {
    // web/app/forgot-password/page.tsx calls the request-password-reset edge
    // function (admin.generateLink, service role) — resetPasswordForEmail()
    // does not appear anywhere in it.
    assert.doesNotMatch(webForgotPw, /resetPasswordForEmail/);
    assert.match(webForgotPw, /sb\.functions\.invoke\("request-password-reset"/);
  });
});

/* ── 8. No affected flow has an unprotected fallback ──────────────────────── */

describe('none of the five fixed call sites can reach Supabase without a real token', () => {
  test('mobile sign-in: no code path between the challenge and signIn() skips the ok-check', () => {
    const i = mobileSignIn.indexOf('const turnstile = await getTurnstileToken();');
    const j = mobileSignIn.indexOf('await signIn(');
    const between = mobileSignIn.slice(i, j);
    // Exactly one guarded return, nothing else in between that could fall through.
    const returns = between.match(/return;/g) ?? [];
    assert.equal(returns.length, 1);
  });

  test('mobile resend: no code path skips the ok-check', () => {
    const i = mobileSignUp.indexOf('const turnstile = await getTurnstileToken();', mobileSignUp.indexOf('async function handleResend'));
    const j = mobileSignUp.indexOf('await supabase.auth.resend(');
    const between = mobileSignUp.slice(i, j);
    const returns = between.match(/return;/g) ?? [];
    assert.equal(returns.length, 1);
  });

  test('mobile password reset: no code path skips the ok-check', () => {
    const i = mobileForgotPw.indexOf('const turnstile = await getTurnstileToken();');
    const j = mobileForgotPw.indexOf('await supabase.auth.resetPasswordForEmail(');
    const between = mobileForgotPw.slice(i, j);
    const returns = between.match(/return;/g) ?? [];
    assert.equal(returns.length, 1);
  });

  test('web sign-in and resend: both guarded returns precede their Supabase call, and the buttons are disabled besides', () => {
    assert.match(webSignIn, /if \(!captchaToken\) \{ setError\("Please complete the verification check below\."\); return; \}\s*\n\s*setBusy\(true\);/);
    assert.match(webSignIn, /if \(!captchaToken\) \{ setError\("Please complete the verification check below\."\); return; \}\s*\n\s*setResending\(true\)/);
  });

  test('getTurnstileToken() itself never fabricates a token — every branch is an explicit ok/fail result (unchanged)', () => {
    assert.doesNotMatch(mobileTurnstileLib, /ok:\s*true(?![\s\S]{0,20}token)/);
    assert.match(mobileTurnstileLib, /if \(!token\) return \{ ok: false/);
  });
});

/* ── 9 & 10. Web: fresh token per action, never reused ────────────────────── */

describe('web: the token is single-use across both sign-in and resend', () => {
  test('the widget is reset after every sign-in attempt, success or failure, before branching', () => {
    const i = webSignIn.indexOf('async function submit');
    const body = webSignIn.slice(i, webSignIn.indexOf('async function resendConfirmation') > -1 && webSignIn.indexOf('async function resendConfirmation') < i
      ? webSignIn.length
      : webSignIn.indexOf('return (', i));
    const resetIdx = body.indexOf('turnstileRef.current?.reset();');
    const errorBranchIdx = body.indexOf('if (error) {');
    assert.ok(resetIdx !== -1 && errorBranchIdx !== -1 && resetIdx < errorBranchIdx,
      'reset must happen before branching on the sign-in result, not only on failure');
  });

  test('the widget is reset after every resend attempt, inside the same function that made the call', () => {
    const i = webSignIn.indexOf('async function resendConfirmation');
    const j = webSignIn.indexOf('async function submit');
    const body = webSignIn.slice(i, j);
    assert.match(body, /turnstileRef\.current\?\.reset\(\);/);
    // Reset happens after the resend call, not before (a pre-call reset would
    // just null out the very token the call is about to use).
    const resendCallIdx = body.indexOf('.auth.resend(');
    const resetIdx = body.indexOf('turnstileRef.current?.reset();');
    assert.ok(resendCallIdx !== -1 && resetIdx > resendCallIdx);
  });

  test('a single ref/state pair is shared by sign-in and resend — resetting one cannot leave the other holding a stale token', () => {
    const refDeclarations = webSignIn.match(/useRef<TurnstileHandle>\(null\)/g) ?? [];
    const tokenStateDeclarations = webSignIn.match(/useState<string \| null>\(null\)/g) ?? [];
    assert.equal(refDeclarations.length, 1, 'exactly one Turnstile ref on the page — both actions share it');
    assert.equal(tokenStateDeclarations.length, 1, 'exactly one captchaToken state on the page — both actions share it');
  });

  test('the widget itself nulls the token on reset, expiry, error and timeout (unchanged, proven in turnstile-signup-protection.node.test.ts)', () => {
    const turnstileUi = code(readFileSync(join(WEB_ROOT, 'components/ui/Turnstile.tsx'), 'utf8'));
    assert.match(turnstileUi, /useImperativeHandle\(ref, \(\) => \(\{\s*reset: \(\) => \{/);
  });
});

/* ── 11. Mobile: a fresh token is obtained per action, none cached ───────── */

describe('mobile: each of the three fixed actions calls getTurnstileToken() itself — none share a cached token', () => {
  test('three distinct call sites for getTurnstileToken(), one per affected action', () => {
    const signInCalls = (mobileSignIn.match(/await getTurnstileToken\(\)/g) ?? []).length;
    const signUpFileCalls = (mobileSignUp.match(/await getTurnstileToken\(\)/g) ?? []).length; // signUp + resend + check-confirmed
    const forgotPwCalls = (mobileForgotPw.match(/await getTurnstileToken\(\)/g) ?? []).length;
    assert.equal(signInCalls, 1);
    assert.ok(signUpFileCalls >= 3, 'signUp, handleResend and handleCheckConfirmed each call it independently');
    assert.equal(forgotPwCalls, 1);
  });

  test('getTurnstileToken() has no module-level cache — every call opens a fresh challenge', () => {
    assert.doesNotMatch(mobileTurnstileLib, /let\s+cachedToken/);
    assert.doesNotMatch(mobileTurnstileLib, /let\s+lastToken/);
    assert.match(mobileTurnstileLib, /export async function getTurnstileToken\(\): Promise<TurnstileResult> \{/);
  });
});

/* ── 12. Signup Turnstile behaviour is unchanged ──────────────────────────── */

describe('signup — already-shipped and out of scope for this task — is untouched', () => {
  test('mobile signUp still calls getTurnstileToken() before signUp(), unchanged', () => {
    const i = mobileSignUp.indexOf('async function handleSignUp');
    const body = mobileSignUp.slice(i, mobileSignUp.indexOf('async function handleResend'));
    const tokenIdx = body.indexOf('await getTurnstileToken()');
    const signUpIdx = body.indexOf('await signUp(');
    assert.ok(tokenIdx !== -1 && signUpIdx !== -1 && tokenIdx < signUpIdx);
  });

  test('AuthContext.signUp signature and captchaToken forwarding are unchanged', () => {
    assert.match(authContext, /async function signUp\(email: string, password: string, fullName: string, captchaToken: string, phone\?: string, marketingOptIn = false, next\?: string\)/);
    assert.match(authContext, /captchaToken,\s*\n\s*data:\s*\{\s*full_name: fullName/);
  });

  test('web signUp() call and its Turnstile wiring are unchanged', () => {
    const webSignUp = code(web('app/sign-up/page.tsx'));
    assert.match(webSignUp, /captchaToken,\s*\n\s*data:\s*\{/);
    assert.match(webSignUp, /disabled=\{busy \|\| !agree \|\| !captchaToken\}/);
  });
});

/* ── 13. Session-refresh / auth-state paths are unchanged ────────────────── */

describe('session management is untouched — no captchaToken added where the SDK has no such option', () => {
  test('getSession and onAuthStateChange wiring in AuthContext is unchanged', () => {
    assert.match(authContext, /supabase\.auth\.getSession\(\)\.then\(\(\{ data: \{ session \} \}\) => \{/);
    assert.match(authContext, /\} = supabase\.auth\.onAuthStateChange\(\(_event, session\) => \{/);
  });

  test('signOut is unchanged — still a bare call, no options', () => {
    assert.match(authContext, /await supabase\.auth\.signOut\(\);/);
  });

  test('explicit refreshSession() call (local-stamp-scanner.tsx) is unchanged — no options added', () => {
    const scanner = code(read('app/local-stamp-scanner.tsx'));
    assert.match(scanner, /await supabase\.auth\.refreshSession\(\);/);
  });
});

/* ── 14. Confirmation flows are unchanged ─────────────────────────────────── */

describe('email-confirmation and password-reset-verification flows are untouched', () => {
  test('mobile app/auth/confirm.tsx still routes straight to sign-in with no token handling', () => {
    assert.doesNotMatch(mobileConfirm, /access_token/);
    assert.doesNotMatch(mobileConfirm, /captchaToken/);
    assert.match(mobileConfirm, /pathname: '\/\(auth\)\/sign-in' as const/);
  });

  test('web /auth/callback still verifies via token_hash/exchangeCodeForSession, no captchaToken', () => {
    assert.match(webCallback, /verifyOtp\(\{ type, token_hash: tokenHash \}\)/);
    assert.match(webCallback, /exchangeCodeForSession\(code\)/);
    assert.doesNotMatch(webCallback, /captchaToken/);
  });

  test('web /reset-password verification and updateUser are unchanged, no captchaToken', () => {
    assert.match(webResetPw, /verifyOtp\(\{\s*token_hash: tokenHash,/);
    assert.match(webResetPw, /exchangeCodeForSession\(code\)/);
    assert.match(webResetPw, /updateUser\(\{ password \}\)/);
    assert.doesNotMatch(webResetPw, /captchaToken/);
  });
});
