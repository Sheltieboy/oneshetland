/**
 * password-reset-identity.node.test.ts — whose password is about to change?
 *
 * Reproduced in production before this was written: user B's reset link, used
 * once and therefore dead, pasted into a browser signed in as user A. The page
 * asked getSession(), got A, and offered a password form — labelled with
 * nobody. Submitting it would have changed A's password.
 *
 * So the rule these tests hold down is narrow and absolute: if the URL carried
 * recovery material, the outcome depends ONLY on whether that material
 * verified. Somebody else's live session is never a substitute for a reset
 * link, and the account being changed is always named on screen.
 *
 * The page is a client component, so its decision logic is extracted from the
 * real source and executed against fake Supabase clients — the states are what
 * matter, not the markup.
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
const readWeb = (p: string) => readFileSync(join(WEB, p), 'utf8');

const PAGE = readWeb('app/reset-password/page.tsx');

/* ── The real decision logic, lifted out of the page ────────────────────── */

/**
 * Extracts the body of the mount effect and runs it with stand-in Supabase
 * clients. If the page's logic is edited, this runs the edited logic — the
 * point of doing it this way rather than asserting on strings.
 */
function buildRunner() {
  const deTs = (src: string) => src
    // new Function is plain JS; the page is TypeScript. Strip the two
    // annotation shapes it actually uses, and nothing else.
    .replace(/\bas\s+"[^"]*"/g, '')
    .replace(/\blet\s+(\w+)\s*:[^=]+=/g, 'let $1 =')
    .replace(/\)\s*:\s*Promise<[^>]*>\s*\{/g, ') {');

  // The identity helper — included so the REAL getUser() call is under test.
  const hStart = PAGE.indexOf('    async function verifiedEmail(');
  const hEnd = PAGE.indexOf('\n    }', hStart) + '\n    }'.length;
  assert.ok(hStart > 0 && hEnd > hStart, 'could not locate verifiedEmail');

  // The mount effect's decision logic.
  const bStart = PAGE.indexOf('      const url = new URL(window.location.href);');
  const bEnd = PAGE.indexOf('      setStatus("invalid");\n      setWhy(failure);\n    })();');
  assert.ok(bStart > 0 && bEnd > bStart, 'could not locate the mount effect body');
  const body = PAGE.slice(bStart, bEnd) + '      setStatus("invalid");\n      setWhy(failure);\n';

  return new Function('sb', 'window', 'setStatus', 'setWhy', 'setIdentity', 'active',
    `return (async () => {\n${deTs(PAGE.slice(hStart, hEnd))}\n${deTs(body)}\n})();`);
}
const runEffect = buildRunner();

interface FakeOpts {
  href: string;
  /** Result of verifyOtp / exchangeCodeForSession. */
  verify?: { error?: { message: string } };
  /** Who getUser() reports AFTER any verification. */
  userAfter?: { email: string } | null;
  /** Who getSession() reports — the stale session in the bug. */
  session?: boolean;
}

async function run(opts: FakeOpts) {
  const calls: string[] = [];
  const sb = {
    auth: {
      verifyOtp: async () => { calls.push('verifyOtp'); return opts.verify ?? {}; },
      exchangeCodeForSession: async () => { calls.push('exchange'); return opts.verify ?? {}; },
      getSession: async () => ({ data: { session: opts.session ? { user: {} } : null } }),
      getUser: async () => ({ data: { user: opts.userAfter ?? null } }),
    },
  };
  let replaced = false;
  const win = {
    location: { href: opts.href },
    history: { replaceState: () => { replaced = true; } },
  };
  let status = 'checking';
  let why: string | null = null;
  let identity: string | null = null;
  await runEffect(sb, win,
    (s: string) => { status = s; },
    (w: string | null) => { why = w; },
    (i: string | null) => { identity = i; },
    true);
  return { status, why, identity, replaced, calls };
}

const BASE = 'https://oneshetland.com/reset-password';

/* ── 1. The bug, and the rule that replaces it ──────────────────────────── */

describe('a dead reset link is dead, whoever else is signed in', () => {
  test('THE DEFECT: consumed token for B while A is signed in shows no form', async () => {
    const r = await run({
      href: `${BASE}?token_hash=spent&type=recovery`,
      verify: { error: { message: 'Email link is invalid or has expired' } },
      session: true,                       // A is signed in — this used to win
      userAfter: { email: 'a@probe.invalid' },
    });
    assert.equal(r.status, 'invalid', "A's session must not stand in for B's dead link");
    assert.equal(r.identity, null, 'no identity may be offered for a link that failed');
  });

  test('and A cannot be walked into changing their own password', async () => {
    const r = await run({
      href: `${BASE}?token_hash=spent&type=recovery`,
      verify: { error: { message: 'Email link is invalid or has expired' } },
      session: true,
      userAfter: { email: 'a@probe.invalid' },
    });
    // 'invalid' is the only state that renders no password fields.
    assert.notEqual(r.status, 'recovery');
    assert.notEqual(r.status, 'session');
  });

  test("Supabase's own reason survives", async () => {
    const r = await run({
      href: `${BASE}?token_hash=spent&type=recovery`,
      verify: { error: { message: 'Email link is invalid or has expired' } },
      session: true,
    });
    assert.match(String(r.why), /invalid or has expired/);
  });

  test('a legacy ?code= link that fails behaves the same way', async () => {
    const r = await run({
      href: `${BASE}?code=spent`,
      verify: { error: { message: 'invalid request' } },
      session: true,
      userAfter: { email: 'a@probe.invalid' },
    });
    assert.equal(r.status, 'invalid');
  });

  test('a hash carrying an error is a failed link, not an invitation', async () => {
    const r = await run({
      href: `${BASE}#error=access_denied&error_description=Email+link+is+invalid`,
      session: true,
      userAfter: { email: 'a@probe.invalid' },
    });
    assert.equal(r.status, 'invalid');
    assert.match(String(r.why), /invalid/i);
  });
});

/* ── 2. What a valid link does ──────────────────────────────────────────── */

describe('a valid link names the account it is about to change', () => {
  test('clean browser, valid token_hash', async () => {
    const r = await run({ href: `${BASE}?token_hash=good&type=recovery`, userAfter: { email: 'b@probe.invalid' } });
    assert.equal(r.status, 'recovery');
    assert.equal(r.identity, 'b@probe.invalid');
    assert.ok(r.calls.includes('verifyOtp'));
  });

  test("B's valid link inside A's browser shows B, not A", async () => {
    // verifyOtp replaces the session, so the verified user afterwards is B.
    const r = await run({
      href: `${BASE}?token_hash=good&type=recovery`,
      session: true,                        // A was here first
      userAfter: { email: 'b@probe.invalid' },
    });
    assert.equal(r.status, 'recovery');
    assert.equal(r.identity, 'b@probe.invalid', 'the page must name the recovery account');
  });

  test('legacy ?code= still works — cross-device links already in inboxes', async () => {
    const r = await run({ href: `${BASE}?code=good`, userAfter: { email: 'b@probe.invalid' } });
    assert.equal(r.status, 'recovery');
    assert.ok(r.calls.includes('exchange'));
  });

  test("hash-fragment links still work — the mobile app's own path", async () => {
    const r = await run({
      href: `${BASE}#access_token=abc&type=recovery`,
      session: true,                        // detectSessionInUrl established it
      userAfter: { email: 'b@probe.invalid' },
    });
    assert.equal(r.status, 'recovery');
    assert.equal(r.identity, 'b@probe.invalid');
  });

  test('the single-use token is taken out of the URL and history', async () => {
    const r = await run({ href: `${BASE}?token_hash=good&type=recovery`, userAfter: { email: 'b@probe.invalid' } });
    assert.equal(r.replaced, true);
  });
});

/* ── 3. No link at all ──────────────────────────────────────────────────── */

describe('reaching the page without a link', () => {
  test('signed in: an ordinary password change, labelled as one', async () => {
    const r = await run({ href: BASE, session: true, userAfter: { email: 'a@probe.invalid' } });
    assert.equal(r.status, 'session');
    assert.equal(r.identity, 'a@probe.invalid');
  });

  test('signed out: nothing to do', async () => {
    const r = await run({ href: BASE, userAfter: null });
    assert.equal(r.status, 'invalid');
    assert.equal(r.identity, null);
  });

  test('no token means no verification call is made at all', async () => {
    const r = await run({ href: BASE, session: true, userAfter: { email: 'a@probe.invalid' } });
    assert.deepEqual(r.calls, []);
  });
});

/* ── 4. Where the displayed identity comes from ─────────────────────────── */

describe('the identity is the session, and only the session', () => {
  test('it is read with getUser, which verifies, not getSession', async () => {
    const fn = PAGE.slice(PAGE.indexOf('async function verifiedEmail'));
    const body = fn.slice(0, fn.indexOf('\n    }'));
    assert.match(body, /sb\.auth\.getUser\(\)/);
    assert.ok(!/getSession/.test(body), 'getSession does not verify the token with the server');
  });

  test('a caller-supplied email in the URL changes nothing', async () => {
    const r = await run({
      href: `${BASE}?token_hash=good&type=recovery&email=attacker%40evil.test`,
      userAfter: { email: 'b@probe.invalid' },
    });
    assert.equal(r.identity, 'b@probe.invalid');
  });

  test('the page never reads an email from the URL, a form or storage', () => {
    assert.ok(!/searchParams\.get\(["']email["']\)/.test(PAGE));
    assert.ok(!/localStorage|sessionStorage/.test(PAGE));
    // The only source of the rendered identity is the identity state.
    const render = PAGE.slice(PAGE.indexOf('data-testid="reset-identity"'));
    assert.match(render.slice(0, 200), /\{identity \?\? "your account"\}/);
  });

  test('the form is only ever rendered in the two states that have an identity', () => {
    assert.match(PAGE, /const canSetPassword = status === "recovery" \|\| status === "session";/);
    const form = PAGE.indexOf('<form onSubmit={submit}');
    const gate = PAGE.indexOf('canSetPassword ? (');
    assert.ok(gate > 0 && form > gate, 'the password fields must sit behind canSetPassword');
  });

  test('the two states are labelled differently', () => {
    assert.match(PAGE, /isChange \? "Change password for" : "Resetting password for"/);
    assert.match(PAGE, /isChange \? "Change your password" : "Choose a new password"/);
  });
});

/* ── 5. Everything that must not have moved ─────────────────────────────── */

describe('the rest of the flow is untouched', () => {
  test('password rules and confirmation', () => {
    assert.match(PAGE, /password\.length < 8/);
    assert.match(PAGE, /password !== confirm/);
  });

  test('compliance logging and the post-reset redirect', () => {
    assert.match(PAGE, /eventType: "password\.changed", metadata: \{ screen: "reset-password" \}/);
    assert.match(PAGE, /router\.replace\("\/account"\)/);
  });

  test('updateUser still acts on the session, with no user argument', () => {
    assert.match(PAGE, /sb\.auth\.updateUser\(\{ password \}\)/);
  });

  test('the reset email still carries a token_hash, generated server-side', () => {
    const fn = readFileSync(join(REPO_ROOT, 'supabase/functions/request-password-reset/index.ts'), 'utf8');
    assert.match(fn, /type: 'recovery'/);
    assert.match(fn, /hashed_token/);
    assert.match(fn, /searchParams\.set\('token_hash', hashedToken\)/);
    assert.match(fn, /templateKey: 'account\.password_reset'/);
  });

  test('forgot-password still refuses to say whether an address is registered', () => {
    const page = readWeb('app/forgot-password/page.tsx');
    assert.match(page, /never reveals whether the account exists|always succeeds/i);
    assert.match(page, /\.catch\(\(\) => \{\}\)/);
    const fn = readFileSync(join(REPO_ROOT, 'supabase/functions/request-password-reset/index.ts'), 'utf8');
    assert.match(fn, /return ok\(\)/);
  });

  test('the mobile app still lands on this same page', () => {
    const m = readFileSync(join(REPO_ROOT, 'app/(auth)/forgot-password.tsx'), 'utf8');
    assert.match(m, /const RESET_REDIRECT = 'https:\/\/oneshetland\.com\/reset-password'/);
    assert.match(m, /resetPasswordForEmail/);
  });
});
