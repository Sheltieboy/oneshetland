/**
 * signup-confirmation.node.test.ts — confirming your email on the other device.
 *
 * A real controlled signup exposed this. Signed up on a laptop, opened the
 * email on a phone, tapped Confirm, and the site said:
 *
 *     "That confirmation link has expired. Please sign in."
 *
 * It had not expired. Measured on that account: created 13:25:51,
 * email_confirmed_at 13:27:40 — the tap DID confirm the address. What failed
 * was the session, and only because the web client is @supabase/ssr, which
 * uses PKCE: signUp stores a code verifier in a cookie in THAT browser, and
 * exchangeCodeForSession needs it back. The phone never had it.
 *
 * So the message was untrue, the consent audit trail was never written (the
 * compliance_log rows for that user are absent), and the user was told to do
 * something that sounded like a failure when their account was fine.
 *
 * Two halves to the fix and they are independent on purpose:
 *   • token_hash + verifyOtp — verified server-side, no browser state, so the
 *     phone genuinely gets a session. Needs the email template to send it.
 *   • honest wording — nothing claims a link expired unless Supabase said so.
 *
 * The route accepts both shapes so the deploy can land before the template
 * changes, in either order, without a gap.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT  = join(REPO_ROOT, '..', 'oneshetland-web');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\*|\{\/\*).*$/gm, '');

const readWeb = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');
const read    = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');

const callback   = code(readWeb('app/auth/callback/route.ts'));
const signIn     = code(readWeb('app/sign-in/page.tsx'));
const signUpWeb  = code(readWeb('app/sign-up/page.tsx'));
const redirect   = code(readWeb('lib/redirect.ts'));
const compliance = code(readWeb('lib/compliance.server.ts'));
const authCtx    = code(read('context/AuthContext.tsx'));
const appConfirm = code(read('app/auth/confirm.tsx'));

/* ── 1. The two confirmation shapes ─────────────────────────────────────── */

describe('a confirmation link works wherever it is opened', () => {
  test('token_hash is verified server-side, with no browser state', () => {
    assert.match(callback, /verifyOtp\(\{ type, token_hash: tokenHash \}\)/);
    // It must be tried FIRST: it is the shape that works cross-device.
    assert.ok(callback.indexOf('verifyOtp') < callback.indexOf('exchangeCodeForSession'),
      'the device-independent path must be preferred');
  });

  test('the PKCE code path is kept, so same-device links still work', () => {
    assert.match(callback, /exchangeCodeForSession\(code\)/);
  });

  test('both shapes are accepted, so the template can change in either order', () => {
    assert.match(callback, /searchParams\.get\("token_hash"\)/);
    assert.match(callback, /searchParams\.get\("code"\)/);
  });

  test('only real OTP types are passed to Supabase', () => {
    assert.match(callback, /const OTP_TYPES = \[/);
    assert.match(callback, /includes\(v\) \? \(v as EmailOtpType\) : null/);
    const guard = callback.indexOf('OTP_TYPES');
    assert.ok(guard < callback.indexOf('verifyOtp'), 'the type is validated before it is used');
  });
});

/* ── 2. Never claim something we were not told ──────────────────────────── */

describe('the failure messages are true', () => {
  test('only the token_hash path may call a link invalid', () => {
    const verifyBranch = callback.slice(callback.indexOf('if (tokenHash && type)'), callback.indexOf('if (code)'));
    assert.match(verifyBranch, /confirm_invalid/);
    // Scoped to the branch itself — the route's final fallback (no token of
    // any kind present) is legitimately allowed to say invalid.
    // The branch ends at its own confirm_session return; the route's final
    // fallback (no token of any kind present) is legitimately allowed to say
    // invalid, and must not be swept into this assertion.
    const codeStart = callback.indexOf('if (code)');
    const codeBranch = callback.slice(codeStart, callback.indexOf('confirm_session') + 20);
    assert.match(codeBranch, /confirm_session/);
    assert.ok(!/confirm_invalid/.test(codeBranch),
      'a failed PKCE exchange does not tell us the token was bad');
  });

  test('the untrue "expired" wording is gone from the product', () => {
    assert.ok(!/confirmation link has expired/i.test(signIn),
      'the site must not claim a link expired when it does not know that');
  });

  test('a cross-device confirmation reads as reassurance, not failure', () => {
    const m = signIn.match(/confirm_session"\s*\?\s*\n?\s*"([^"]+)"/);
    assert.ok(m, 'the cross-device message exists');
    const msg = m![1];
    assert.match(msg, /may already be confirmed/i);
    assert.match(msg, /different device/i);
    assert.match(msg, /sign(ing)? in below/i);
    assert.ok(!/expired/i.test(msg), 'it must not say expired');
  });

  test('and it is shown as a notice, not as an error', () => {
    assert.match(signIn, /const \[notice, setNotice\]/);
    assert.match(signIn, /notice && !error/);
    assert.match(signIn, /bg-sand[\s\S]{0,120}\{notice\}/);
  });

  test('a genuinely invalid token still says so plainly', () => {
    assert.match(signIn, /confirm_invalid"\s*\n?\s*\?\s*"That confirmation link is no longer valid/);
  });

  test('links already sitting in inboxes are still handled', () => {
    assert.match(signIn, /confirmState === "confirm"/, 'the old ?error=confirm shape');
  });
});

/* ── 3. Getting another one ─────────────────────────────────────────────── */

describe('a resend exists, and only where it helps', () => {
  test('it is offered on both confirmation failures', () => {
    assert.match(signIn, /confirmState === "confirm_invalid" \|\| confirmState === "confirm_session"/);
    assert.match(signIn, /Send a new confirmation email/);
  });

  test('it uses Supabase resend, carrying the same callback', () => {
    assert.match(signIn, /auth\.resend\(\{/);
    assert.match(signIn, /type: "signup"/);
    assert.match(signIn, /emailRedirectTo: `\$\{window\.location\.origin\}\/auth\/callback\?next=/);
  });

  test('the answer never reveals whether that address has an account', () => {
    const fn = signIn.slice(signIn.indexOf('async function resendConfirmation'));
    assert.match(fn, /catch \{[\s\S]{0,120}\}/, 'the provider answer is swallowed');
    assert.match(signIn, /If that address needs confirming, a new link is on its way/);
    assert.ok(!/no account|not found|already confirmed/i.test(fn),
      'nothing may distinguish a known address from an unknown one');
  });
});

/* ── 4. The audit trail the cross-device user never got ─────────────────── */

describe('consent is recorded on whichever path confirms', () => {
  test('both success branches write it', () => {
    const hits = callback.match(/recordSignupConsent\(sb, user\)/g) ?? [];
    assert.equal(hits.length, 2, 'token_hash and code paths both record consent');
  });

  test('and it is still written exactly once per user', () => {
    // The real guard, not the comment describing it: an existing
    // terms.accepted row for this user stops a second trail being appended.
    assert.match(compliance, /\.eq\("event_type", "terms\.accepted"\)/);
    assert.match(compliance, /if \(already\) return;/);
  });
});

/* ── 5. Redirect safety is unchanged ────────────────────────────────────── */

describe('nothing here opens a redirect', () => {
  test('every destination goes through safeNext', () => {
    assert.match(callback, /const next = safeNext\(searchParams\.get\("next"\)\)/);
    const redirects = callback.match(/NextResponse\.redirect\(`\$\{origin\}[^`]*`\)/g) ?? [];
    assert.ok(redirects.length >= 4, 'all redirect targets were found');
    for (const r of redirects) {
      assert.ok(r.includes('${origin}'), `redirect must stay on this origin: ${r}`);
    }
  });

  test('safeNext still refuses the hostile shapes', () => {
    assert.match(redirect, /startsWith\("\/\/"\)/);
    assert.match(redirect, /\/\^\[a-z\]\[a-z0-9\+\.-\]\*:\/i/);
  });

  test('the token is never logged', () => {
    assert.ok(!/console\.(log|error|warn)/.test(callback),
      'a confirmation token must not reach the logs');
  });

  test('no service-role key is anywhere near this route', () => {
    assert.ok(!/SERVICE_ROLE/.test(callback) && !/SERVICE_ROLE/.test(signIn));
  });
});

/* ── 6. The app keeps its own path ──────────────────────────────────────── */

describe('the mobile confirmation is untouched', () => {
  test('the app still deep-links and sets the session from the fragment', () => {
    assert.match(authCtx, /oneshetland-fetch:\/\/auth\/confirm/);
    assert.match(appConfirm, /access_token/);
    assert.match(appConfirm, /setSession\(\{ access_token, refresh_token \}\)/);
  });

  test('each client stamps which one started the sign-up', () => {
    // The email template branches on this: the app needs its deep link, the
    // web needs a token_hash URL that survives being opened elsewhere.
    assert.match(signUpWeb, /signup_platform: "web"/);
    assert.match(authCtx, /signup_platform: 'app'/);
  });
});
