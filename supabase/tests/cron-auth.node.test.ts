/**
 * cron-auth.node.test.ts — the scheduler's credential check fails closed.
 *
 * WHY THIS TEST EXISTS
 *
 * Four Edge Functions run with verify_jwt=false, because pg_cron reaches them
 * through pg_net with no Authorization header — only `x-cron-secret`. Their own
 * guard was therefore the entire boundary, and all four wrote it as:
 *
 *   const secret = Deno.env.get('CRON_SECRET');
 *   if (secret && req.headers.get('x-cron-secret') !== secret) return 403;
 *
 * With CRON_SECRET undefined, `secret &&` is falsy, the check is skipped, and
 * the request proceeds. The endpoint was MORE permissive with no server secret
 * than with one — and silently so: nothing errors, nothing logs, it simply
 * starts answering everybody. One of these sends notifications, one posts
 * publicly to Facebook, one imports jobs, and reminder-runner invokes the
 * billing meter.
 *
 * The secret was configured, so it was never exploitable through the live
 * setup. That is not the same as being safe: a boundary that holds only while
 * an environment variable happens to be present is not a boundary.
 *
 * WHAT IS ASSERTED
 *   · missing, empty and whitespace-only server secret → 503, never permitted
 *   · missing and wrong caller header → 401
 *   · a correct credential is permitted
 *   · the refusal body says nothing about why
 *   · the environment read itself fails closed, not just the pure decision
 *   · no privileged work appears between serve() and the guard in any of them
 *   · the four functions stay verify_jwt=false — the fix must not have been
 *     "turn JWT verification on", which would break the proven scheduler path
 *   · no function re-grows its own optional-secret check
 *   · the credential is never logged
 *
 * SAFETY
 * A dummy secret is used throughout. The production CRON_SECRET is never read,
 * printed, or required for any of this to run.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideCronAuth, cronAuthResponse, requireCronSecret } from '../functions/_shared/cron-auth.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FUNCTIONS = join(REPO_ROOT, 'supabase', 'functions');

/** The four scheduled functions, derived in the inventory test below. */
const SCHEDULED = ['reminder-runner', 'social-composer', 'social-publisher', 'sync-council-jobs'];

const DUMMY = 'test-secret-not-a-real-credential-0000';
const CORS = { 'Access-Control-Allow-Origin': '*' };

const req = (headers: Record<string, string> = {}) =>
  new Request('https://example.test/', { method: 'POST', headers });

// ── 1. The case that failed open ────────────────────────────────────────────

describe('a missing server secret refuses, it does not open the door', () => {
  for (const [label, value] of [
    ['undefined',       undefined],
    ['null',            null],
    ['empty string',    ''],
    ['whitespace only', '   '],
  ] as const) {
    test(`server secret ${label} → 503, not permitted`, () => {
      // With a header supplied, so the ONLY thing wrong is the server config.
      // Under the old guard this exact call was ALLOWED through.
      const outcome = decideCronAuth(value, 'anything-at-all');
      assert.equal(outcome.ok, false, `server secret ${label} permitted the request — this is the original bug`);
      assert.equal((outcome as { status: number }).status, 503,
        `server secret ${label} should be 503 (our misconfiguration), not a caller error`);
    });

    test(`server secret ${label} → 503 even with no header at all`, () => {
      const outcome = decideCronAuth(value, undefined);
      assert.equal(outcome.ok, false);
      assert.equal((outcome as { status: number }).status, 503);
    });
  }

  test('an empty server secret cannot be matched by an empty header', () => {
    // The trap in a naive rewrite: '' === '' is true.
    const outcome = decideCronAuth('', '');
    assert.equal(outcome.ok, false, 'an empty secret matched an empty header');
    assert.equal((outcome as { status: number }).status, 503);
  });
});

// ── 2. Caller credentials ───────────────────────────────────────────────────

describe('the caller must present the credential', () => {
  test('no header → 401', () => {
    const outcome = decideCronAuth(DUMMY, undefined);
    assert.equal(outcome.ok, false);
    assert.equal((outcome as { status: number }).status, 401);
  });

  test('empty header → 401', () => {
    const outcome = decideCronAuth(DUMMY, '');
    assert.equal(outcome.ok, false);
    assert.equal((outcome as { status: number }).status, 401);
  });

  for (const [label, value] of [
    ['wrong value',        'completely-different'],
    ['right length, wrong','test-secret-not-a-real-credential-XXXX'],
    ['a prefix',           'test-secret'],
    ['with trailing space', `${DUMMY} `],
  ] as const) {
    test(`${label} → 401`, () => {
      const outcome = decideCronAuth(DUMMY, value);
      assert.equal(outcome.ok, false, `"${label}" was accepted`);
      assert.equal((outcome as { status: number }).status, 401);
    });
  }

  test('the correct credential is permitted', () => {
    const outcome = decideCronAuth(DUMMY, DUMMY);
    assert.equal(outcome.ok, true, 'the legitimate scheduler call was refused — cron would break');
  });
});

// ── 3. What the caller is told ──────────────────────────────────────────────

describe('refusals leak nothing', () => {
  test('401 body names no detail', async () => {
    const res = cronAuthResponse(decideCronAuth(DUMMY, 'wrong'), CORS)!;
    assert.equal(res.status, 401);
    const body = await res.text();
    assert.equal(body, JSON.stringify({ error: 'unauthorized' }));
    assert.ok(!body.includes(DUMMY), 'the response echoed the expected secret');
    for (const leak of ['length', 'expected', 'CRON_SECRET', 'missing', 'header']) {
      assert.ok(!body.toLowerCase().includes(leak.toLowerCase()),
        `the 401 body mentions "${leak}" — it distinguishes failure modes to an attacker`);
    }
  });

  test('missing header and wrong header are indistinguishable to the caller', async () => {
    const a = cronAuthResponse(decideCronAuth(DUMMY, undefined), CORS)!;
    const b = cronAuthResponse(decideCronAuth(DUMMY, 'wrong'), CORS)!;
    assert.equal(a.status, b.status);
    assert.equal(await a.text(), await b.text());
  });

  test('503 body says only "unavailable"', async () => {
    const res = cronAuthResponse(decideCronAuth(undefined, DUMMY), CORS)!;
    assert.equal(res.status, 503);
    const body = await res.text();
    assert.equal(body, JSON.stringify({ error: 'unavailable' }));
    assert.ok(!body.includes('CRON_SECRET'), 'the 503 body names the missing variable to the caller');
  });

  test('a permitted request produces no response at all', () => {
    assert.equal(cronAuthResponse(decideCronAuth(DUMMY, DUMMY), CORS), null);
  });
});

// ── 4. The real entry point, including the environment read ─────────────────

describe('requireCronSecret is what the functions actually call', () => {
  test('permits a correct header', () => {
    const denied = requireCronSecret(req({ 'x-cron-secret': DUMMY }), CORS, () => DUMMY);
    assert.equal(denied, null, 'the scheduler would have been refused');
  });

  test('refuses a wrong header with 401', () => {
    const denied = requireCronSecret(req({ 'x-cron-secret': 'nope' }), CORS, () => DUMMY);
    assert.equal(denied?.status, 401);
  });

  test('refuses with 503 when the environment has no secret', () => {
    const denied = requireCronSecret(req({ 'x-cron-secret': DUMMY }), CORS, () => undefined);
    assert.equal(denied?.status, 503, 'an unconfigured deployment would serve the request');
  });

  test('the DEFAULT environment read also fails closed', () => {
    // Exercises the production path — the Deno.env.get default argument — with
    // a stubbed global, rather than trusting that the injected version behaves
    // the same. Never touches the real project secret.
    const g = globalThis as unknown as { Deno?: unknown };
    const had = 'Deno' in g;
    const prev = g.Deno;
    try {
      g.Deno = { env: { get: () => undefined } };
      const denied = requireCronSecret(req({ 'x-cron-secret': DUMMY }), CORS);
      assert.equal(denied?.status, 503, 'the real Deno.env path did not fail closed');

      g.Deno = { env: { get: () => DUMMY } };
      assert.equal(requireCronSecret(req({ 'x-cron-secret': DUMMY }), CORS), null,
        'the real Deno.env path refused a correct credential');
    } finally {
      if (had) g.Deno = prev; else delete g.Deno;
    }
  });
});

// ── 5. Structure: nobody hand-rolls this again ──────────────────────────────

describe('every scheduled function uses the shared guard', () => {
  const read = (fn: string) => readFileSync(join(FUNCTIONS, fn, 'index.ts'), 'utf8');

  test('the inventory of CRON_SECRET users is exactly the four known functions', () => {
    // A new scheduled function reading CRON_SECRET itself, instead of importing
    // the helper, fails here — which is the review prompt.
    let out = '';
    try {
      out = execFileSync('grep', ['-rl', 'CRON_SECRET', '--include=index.ts', FUNCTIONS],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      // grep exits 1 on no match; that is not a failure of the command.
      const err = e as { status?: number; stdout?: string };
      if (err.status !== 1) out = err.stdout ?? '';
    }
    const found = out.split('\n').filter(Boolean)
      .map((p) => p.replace(`${FUNCTIONS}/`, '').replace('/index.ts', '')).sort();
    assert.deepEqual(found, [...SCHEDULED].sort(),
      `functions referencing CRON_SECRET changed: ${found.join(', ')}. A new one must use requireCronSecret from _shared/cron-auth.ts.`);
  });

  for (const fn of SCHEDULED) {
    test(`${fn} imports the helper and keeps no guard of its own`, () => {
      const src = read(fn);
      assert.ok(src.includes("from '../_shared/cron-auth.ts'"),
        `${fn} does not import the shared guard`);
      assert.ok(/const denied = requireCronSecret\(req, corsHeaders\);\s*\n\s*if \(denied\) return denied;/.test(src),
        `${fn} does not call requireCronSecret in the expected form`);
      assert.ok(!/if \(\s*secret\s*&&/.test(src),
        `${fn} still contains an optional-secret guard — it can fail open`);
      assert.ok(!/Deno\.env\.get\(['"]CRON_SECRET['"]\)/.test(src),
        `${fn} reads CRON_SECRET directly instead of going through the helper`);
    });

    test(`${fn} authenticates before doing anything privileged`, () => {
      const src = read(fn);
      const serveAt = src.indexOf('serve(');
      const guardAt = src.indexOf('requireCronSecret(req');
      assert.ok(serveAt >= 0 && guardAt > serveAt, `${fn}: could not locate the handler and its guard`);

      const preamble = src.slice(serveAt, guardAt);
      // Anything that touches the database, the network, another function or
      // the request body is a side effect and must not precede the guard.
      for (const [label, re] of [
        ['a database call',      /\.(from|rpc)\(/],
        ['an outbound fetch',    /\bfetch\(/],
        ['invoking a function',  /functions\.invoke\(/],
        ['reading the body',     /req\.(json|text|formData)\(/],
        ['an await',             /\bawait\b/],
        ['a service client',     /createServiceClient\(|createClient\(/],
      ] as const) {
        assert.ok(!re.test(preamble),
          `${fn} performs ${label} before authenticating — a rejected caller still causes that`);
      }
    });
  }

  test('the credential is never logged', () => {
    for (const fn of [...SCHEDULED, '_shared/cron-auth']) {
      const src = readFileSync(join(FUNCTIONS, `${fn}${fn.includes('/') ? '.ts' : '/index.ts'}`), 'utf8');
      for (const [label, re] of [
        ['logs the secret variable', /console\.\w+\([^)]*\bsecret\b/i],
        ['logs request headers',     /console\.\w+\([^)]*req\.headers/],
        ['serialises request headers', /JSON\.stringify\(\s*(req\.)?headers/],
      ] as const) {
        assert.ok(!re.test(src), `${fn} ${label}`);
      }
    }
  });
});

// ── 6. The fix must not have been "turn JWT on" ─────────────────────────────

describe('the scheduler path is unchanged', () => {
  test('the four functions remain verify_jwt = false in config.toml', () => {
    // pg_net sends no Authorization header. Flipping these to true would make
    // the gateway reject every scheduled call — a "fix" that breaks the job.
    const toml = readFileSync(join(REPO_ROOT, 'supabase', 'config.toml'), 'utf8');
    for (const fn of SCHEDULED) {
      const m = toml.match(new RegExp(`\\[functions\\.${fn}\\]\\s*\\nverify_jwt = (true|false)`));
      assert.ok(m, `${fn} is no longer pinned in config.toml`);
      assert.equal(m![1], 'false',
        `${fn} was switched to verify_jwt=true — the scheduler sends no JWT and would get 401`);
    }
  });
});
