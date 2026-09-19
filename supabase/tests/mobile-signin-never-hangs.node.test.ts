/**
 * mobile-signin-never-hangs.node.test.ts
 *
 * Fresh TestFlight install, password sign-in: tap Sign in, spinner starts,
 * nothing else happens. What the code proves (and this file pins):
 *
 *   - the challenge stage awaited WebBrowser.openAuthSessionAsync() with no
 *     deadline of any kind;
 *   - handleSignIn had no try/finally, so a throw/rejection skipped
 *     setLoading(false);
 *   - the hosted challenge page had paths that never return control (covered in
 *     mobile-turnstile-challenge-page.node.test.ts).
 *
 * What it does NOT prove: which of those the physical device actually hit.
 * That needs device logs — hence the auth-stage diagnostics tested below.
 *
 * Most tests here EXECUTE the real source — lib/turnstile.ts, the real
 * handleSignIn body, the real AuthContext.signIn, the real SecureStore adapter
 * under the real supabase-js client — against fakes, via _support/load-source.ts.
 * They do not re-implement the logic they check.
 *
 * SAFETY: no network, no Supabase Auth call, no Turnstile, no sign-in. The one
 * supabase-js client built here is handed a fetch that fails the test if it is
 * ever used. Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { withDeadline, TIMED_OUT } from '../../lib/with-deadline.ts';
import { AUTH_STAGES, authStageProps, classifyAuthError, createAuthStageLogger } from '../../lib/auth-stage.ts';
import { createChunkedSecureStorage } from '../../lib/secure-store-adapter.ts';
import { loadModule, extractFunction, extractConst, instantiate, readRepo } from './_support/load-source.ts';

const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

const SIGN_IN_SRC = readRepo('app/(auth)/sign-in.tsx');
const AUTH_CTX_SRC = readRepo('context/AuthContext.tsx');
const TURNSTILE_SRC = readRepo('lib/turnstile.ts');

const flush = () => new Promise((r) => setImmediate(r));
const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

/* ── harnesses ──────────────────────────────────────────────────────────── */

type Log = [string, Record<string, unknown> | undefined];

/** The REAL lib/turnstile.ts, with the native browser and the logger faked. */
function makeTurnstile(open: () => Promise<unknown>, os = 'ios') {
  const logs: Log[] = [];
  const native = { dismissals: 0, opens: 0 };
  const mod = loadModule('lib/turnstile.ts', {
    'react-native': { Platform: { OS: os } },
    'expo-web-browser': {
      openAuthSessionAsync: () => { native.opens++; return open(); },
      dismissAuthSession: () => { native.dismissals++; },
    },
    './with-deadline': { withDeadline, TIMED_OUT },
    './auth-diagnostics': { logAuthStage: (s: string, d?: Record<string, unknown>) => logs.push([s, d]) },
  });
  return { mod, logs, native };
}

const hostedReturn = (qs: string) => ({ type: 'success', url: `oneshetland-fetch://turnstile-callback?${qs}` });

/** The REAL AuthContext.signIn, with supabase and the logger faked. */
function makeContextSignIn(signInWithPassword: (args: any) => Promise<any>, logs: Log[] = []) {
  const fn = extractFunction(AUTH_CTX_SRC, 'async function signIn(');
  return instantiate<(e: string, p: string, c: string) => Promise<{ error: string | null; timedOut?: boolean }>>(fn, {
    supabase: { auth: { signInWithPassword } },
    withDeadline,
    TIMED_OUT,
    SIGN_IN_TIMEOUT_MS: extractConst(AUTH_CTX_SRC, 'SIGN_IN_TIMEOUT_MS'),
    logAuthStage: (s: string, d?: Record<string, unknown>) => logs.push([s, d]),
    classifyAuthError,
  });
}

/** The REAL handleSignIn body, with React state, navigation and services faked. */
function makeScreen(over: {
  getTurnstileToken: () => Promise<any>;
  signIn?: (e: string, p: string, t: string) => Promise<any>;
  logs?: Log[];
  configured?: boolean;
  email?: string;
  password?: string;
}) {
  const state = {
    loading: [] as boolean[],
    errors: [] as (string | null)[],
    alerts: [] as { title: string; message: string }[],
    signInCalls: [] as string[][],
    tokenCalls: 0,
  };
  const submitting = { current: false };
  const scope = {
    isSupabaseConfigured: over.configured ?? true,
    email: over.email ?? '  Person@Example.com ',
    password: over.password ?? 'hunter2-secret',
    setError: (e: string | null) => state.errors.push(e),
    setLoading: (v: boolean) => state.loading.push(v),
    submitting,
    alert: (a: { title: string; message: string }) => state.alerts.push(a),
    TIMEOUT_ALERT: extractConst(SIGN_IN_SRC, 'TIMEOUT_ALERT'),
    logAuthStage: (s: string, d?: Record<string, unknown>) => over.logs?.push([s, d]),
    getTurnstileToken: () => { state.tokenCalls++; return over.getTurnstileToken(); },
    signIn: (e: string, p: string, t: string) => {
      state.signInCalls.push([e, p, t]);
      return (over.signIn ?? (async () => ({ error: null })))(e, p, t);
    },
  };
  const run = instantiate<() => Promise<void>>(extractFunction(SIGN_IN_SRC, 'async function handleSignIn'), scope);
  return { run, state, submitting };
}

const lastLoading = (s: { loading: boolean[] }) => s.loading[s.loading.length - 1];

/* ── the deadline primitive ─────────────────────────────────────────────── */

describe('withDeadline', () => {
  test('a promise that never settles is cut off, and onTimeout releases it once', async () => {
    let released = 0;
    const started = Date.now();
    const result = await withDeadline(new Promise<never>(() => {}), 20, () => { released += 1; });
    assert.equal(result, TIMED_OUT);
    assert.equal(released, 1);
    assert.ok(Date.now() - started < 1000);
  });

  test('a promise that settles in time is passed through, onTimeout never runs, timer is cleared', async () => {
    const before = timers();
    let released = 0;
    const result = await withDeadline(Promise.resolve('token'), 60_000, () => { released += 1; });
    assert.equal(result, 'token');
    assert.equal(released, 0);
    assert.equal(timers(), before, 'a 60s timer must not outlive a settled promise');
  });

  test('a rejection from the work propagates (callers catch it) and clears the timer', async () => {
    const before = timers();
    await assert.rejects(withDeadline(Promise.reject(new Error('native failure')), 60_000), /native failure/);
    assert.equal(timers(), before);
  });

  test('a throwing onTimeout cannot mask the timeout result', async () => {
    const result = await withDeadline(new Promise<never>(() => {}), 10, () => { throw new Error('boom'); });
    assert.equal(result, TIMED_OUT);
  });

  test('a late rejection after the deadline already won is not an unhandled rejection', async () => {
    let rejectLate!: (e: Error) => void;
    const work = new Promise<never>((_, rej) => { rejectLate = rej; });
    const result = await withDeadline(work, 10);
    assert.equal(result, TIMED_OUT);
    rejectLate(new Error('late'));
    await new Promise((r) => setTimeout(r, 20)); // would crash the runner if unhandled
  });
});

/* ── 8. the challenge session cannot outlive 30 seconds ─────────────────── */

describe('8. the challenge/auth-session stage is bounded at 30 seconds', () => {
  test('the ceiling is exactly 30s', () => {
    const { mod } = makeTurnstile(() => new Promise(() => {}));
    assert.equal(mod.CHALLENGE_TIMEOUT_MS, 30_000);
  });

  test('a session that never resolves settles as a timeout at 30s — not before, not after', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { mod, native, logs } = makeTurnstile(() => new Promise(() => {}));

    let settled: any = null;
    void mod.getTurnstileToken().then((r: unknown) => { settled = r; });

    t.mock.timers.tick(29_999);
    await flush();
    assert.equal(settled, null, 'still waiting at 29.999s');

    t.mock.timers.tick(1);
    await flush();
    assert.deepEqual(settled, { ok: false, reason: 'timeout' });

    // The native session is released, so the next attempt is not blocked by
    // WebBrowserAlreadyOpenException: once before opening, once on timeout.
    assert.equal(native.dismissals, 2);
    assert.deepEqual(logs.map((l) => l[0]), ['captcha_session_started', 'captcha_timed_out']);
    assert.equal(logs[1][1]?.reason, 'app_deadline');
  });

  test('a timeout is a failure, never a token', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { mod } = makeTurnstile(() => new Promise(() => {}));
    let settled: any;
    void mod.getTurnstileToken().then((r: unknown) => { settled = r; });
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(settled.ok, false);
    assert.ok(!('token' in settled));
  });

  test('the challenge deadline and the Supabase deadline are separate constants for separate stages', () => {
    assert.match(code(TURNSTILE_SRC), /export const CHALLENGE_TIMEOUT_MS = 30_000;/);
    assert.match(code(AUTH_CTX_SRC), /const SIGN_IN_TIMEOUT_MS = 30_000;/);
    // Each is used only for its own stage.
    assert.doesNotMatch(code(AUTH_CTX_SRC), /CHALLENGE_TIMEOUT_MS/);
    assert.doesNotMatch(code(TURNSTILE_SRC), /SIGN_IN_TIMEOUT_MS/);
    assert.match(code(TURNSTILE_SRC), /withDeadline\(\s*WebBrowser\.openAuthSessionAsync\(CHALLENGE_URL, RETURN_URL\),\s*CHALLENGE_TIMEOUT_MS,/);
    assert.match(code(AUTH_CTX_SRC), /SIGN_IN_TIMEOUT_MS,?\s*\)/);
  });

  test('a hosted-page timeout / script-load timeout is reported as a timeout, and is not a token', async () => {
    for (const reason of ['challenge_timeout', 'script_load_timeout']) {
      const { mod, logs } = makeTurnstile(async () => hostedReturn(`error=${reason}`));
      const r = await mod.getTurnstileToken();
      assert.deepEqual(r, { ok: false, reason: 'timeout' }, reason);
      assert.equal(logs.at(-1)?.[0], 'captcha_timed_out');
      assert.equal(logs.at(-1)?.[1]?.reason, 'hosted_page');
    }
  });

  test('every other hosted failure — expiry, error, script failure, init — is a plain failure, never a token', async () => {
    for (const reason of ['challenge_failed', 'challenge_expired', 'script_load_failed', 'init_failed', 'anything_else']) {
      const { mod } = makeTurnstile(async () => hostedReturn(`error=${reason}`));
      const r = await mod.getTurnstileToken();
      assert.deepEqual(r, { ok: false, reason: 'challenge_failed' }, reason);
    }
  });

  test('a callback with no token, an empty token, or a non-success result is not a pass', async () => {
    const cases: [any, string][] = [
      [hostedReturn(''), 'no_token'],
      [hostedReturn('token='), 'no_token'],
      [{ type: 'cancel' }, 'cancelled'],
      [{ type: 'dismiss' }, 'cancelled'],
      [{ type: 'success' }, 'cancelled'],
    ];
    for (const [result, reason] of cases) {
      const { mod } = makeTurnstile(async () => result);
      assert.deepEqual(await mod.getTurnstileToken(), { ok: false, reason });
    }
  });

  test('a genuine token is the only success', async () => {
    const { mod, logs } = makeTurnstile(async () => hostedReturn('token=REAL-TOKEN'));
    assert.deepEqual(await mod.getTurnstileToken(), { ok: true, token: 'REAL-TOKEN' });
    assert.deepEqual(logs.map((l) => l[0]), ['captcha_session_started', 'captcha_session_completed']);
  });

  test('the native session is cleared before a new one opens, and never on Android (no such lock)', async () => {
    const ios = makeTurnstile(async () => hostedReturn('token=x'));
    await ios.mod.getTurnstileToken();
    assert.equal(ios.native.dismissals, 1);
    const android = makeTurnstile(async () => hostedReturn('token=x'), 'android');
    await android.mod.getTurnstileToken();
    assert.equal(android.native.dismissals, 0);
  });
});

/* ── 9–14, 18. the sign-in screen ──────────────────────────────────────── */

describe('sign-in screen — the spinner always clears', () => {
  test('9. a challenge timeout clears loading, shows the timeout dialog, and never reaches Supabase', async () => {
    const s = makeScreen({ getTurnstileToken: async () => ({ ok: false, reason: 'timeout' }) });
    await s.run();
    assert.equal(s.state.loading[0], true);
    assert.equal(lastLoading(s.state), false, 'the Sign in button is restored');
    assert.equal(s.state.signInCalls.length, 0);
    assert.deepEqual(s.state.alerts, [{
      title: 'Sign in is taking too long',
      message: 'Please check your connection and try again. If the problem continues, close and reopen OneShetland.',
    }]);
    assert.equal(s.submitting.current, false);
  });

  test('9b. loading is restored in the same tick the dialog is raised (not after it is dismissed)', async () => {
    const order: string[] = [];
    const s = makeScreen({ getTurnstileToken: async () => ({ ok: false, reason: 'timeout' }) });
    const scopeAlert = s.state.alerts;
    // Re-run with instrumentation: record relative order of alert vs loading=false.
    const fn = extractFunction(SIGN_IN_SRC, 'async function handleSignIn');
    const run = instantiate<() => Promise<void>>(fn, {
      isSupabaseConfigured: true, email: 'a@b.c', password: 'pw', submitting: { current: false },
      setError: () => {}, setLoading: (v: boolean) => order.push(`loading:${v}`),
      alert: () => order.push('alert'), TIMEOUT_ALERT: extractConst(SIGN_IN_SRC, 'TIMEOUT_ALERT'),
      logAuthStage: () => {}, getTurnstileToken: async () => ({ ok: false, reason: 'timeout' }), signIn: async () => ({ error: null }),
    });
    await run();
    assert.deepEqual(order, ['loading:true', 'alert', 'loading:false']);
    void scopeAlert;
  });

  test('10. a challenge REJECTION clears loading and shows an error instead of hanging', async () => {
    const s = makeScreen({ getTurnstileToken: async () => { throw new Error('WebBrowserAlreadyOpenException'); } });
    await s.run();
    assert.equal(lastLoading(s.state), false);
    assert.equal(s.state.signInCalls.length, 0);
    assert.ok(s.state.errors.includes('Something went wrong signing in. Please try again.'));
    assert.equal(s.submitting.current, false);
  });

  test('11. invalid credentials clear loading and show the credentials message', async () => {
    const s = makeScreen({
      getTurnstileToken: async () => ({ ok: true, token: 'T' }),
      signIn: async () => ({ error: 'Invalid login credentials' }),
    });
    await s.run();
    assert.equal(lastLoading(s.state), false);
    assert.ok(s.state.errors.includes('Email address or password is incorrect. Please try again.'));
    assert.equal(s.state.alerts.length, 0);
  });

  test('11b. unconfirmed email and other errors also clear loading', async () => {
    for (const [msg, shown] of [
      ['Email not confirmed', 'Please confirm your email address first. Check your inbox for a verification link.'],
      ['Something odd', 'Something odd'],
    ]) {
      const s = makeScreen({ getTurnstileToken: async () => ({ ok: true, token: 'T' }), signIn: async () => ({ error: msg }) });
      await s.run();
      assert.equal(lastLoading(s.state), false);
      assert.ok(s.state.errors.includes(shown), msg);
    }
  });

  test('12. a Supabase network timeout clears loading — real signIn, real 30s deadline, never-answering server', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const logs: Log[] = [];
    const contextSignIn = makeContextSignIn(() => new Promise(() => {}), logs);
    const s = makeScreen({ getTurnstileToken: async () => ({ ok: true, token: 'T' }), signIn: contextSignIn, logs });

    let done = false;
    void s.run().then(() => { done = true; });
    await flush();
    assert.equal(done, false, 'spinner is legitimately up while the request is pending');
    assert.equal(lastLoading(s.state), true);

    t.mock.timers.tick(29_999);
    await flush();
    assert.equal(done, false);
    t.mock.timers.tick(1);
    await flush();

    assert.equal(done, true);
    assert.equal(lastLoading(s.state), false);
    assert.equal(s.state.alerts[0].title, 'Sign in is taking too long');
    assert.equal(s.submitting.current, false);
    assert.ok(logs.some(([n, d]) => n === 'auth_timed_out' && d?.reason === 'supabase_deadline'));
  });

  test('12b. a Supabase request that REJECTS is returned as an error, not thrown, and clears loading', async () => {
    const contextSignIn = makeContextSignIn(async () => { throw new TypeError('Network request failed'); });
    assert.deepEqual(await contextSignIn('a@b.c', 'pw', 'T'), { error: 'Network request failed' });
    const s = makeScreen({ getTurnstileToken: async () => ({ ok: true, token: 'T' }), signIn: contextSignIn });
    await s.run();
    assert.equal(lastLoading(s.state), false);
    assert.ok(s.state.errors.includes('Network request failed'));
  });

  test('13. success: signs in once with the real token, raises no error/dialog, and clears loading', async () => {
    const s = makeScreen({
      getTurnstileToken: async () => ({ ok: true, token: 'GENUINE' }),
      signIn: async () => ({ error: null }),
    });
    await s.run();
    assert.deepEqual(s.state.signInCalls, [['person@example.com', 'hunter2-secret', 'GENUINE']]);
    assert.deepEqual(s.state.errors, [null], 'only the initial reset — no error shown');
    assert.equal(s.state.alerts.length, 0);
    assert.equal(lastLoading(s.state), false);
  });

  test('13b. navigation after success is still driven by the session, exactly as before', () => {
    const layout = code(readRepo('app/_layout.tsx'));
    assert.match(layout, /const dest = \(inAuthGroup \? sanitizeNext\(navParams\?\.next\) : null\) \?\? '\/\(tabs\)';\s*router\.replace\(dest as never\);/);
    // The screen itself does not navigate: it must not race the root layout.
    const body = code(extractFunction(SIGN_IN_SRC, 'async function handleSignIn'));
    assert.doesNotMatch(body, /router\./);
  });

  test('14. a repeat submit while one is pending is ignored; the lock is released afterwards', async () => {
    let release!: (v: unknown) => void;
    const s = makeScreen({
      getTurnstileToken: () => new Promise((res) => { release = res; }),
    });
    const first = s.run();
    await flush();
    await s.run(); // keyboard "done" tapped while the challenge is up
    await s.run();
    assert.equal(s.state.tokenCalls, 1, 'no second challenge — it would dismiss the first');
    assert.equal(s.submitting.current, true);

    release({ ok: false, reason: 'cancelled' });
    await first;
    assert.equal(s.submitting.current, false);
    assert.equal(lastLoading(s.state), false);

    release = () => {};
    void s.run();
    await flush();
    assert.equal(s.state.tokenCalls, 2, 'a fresh attempt after the first finished is allowed');
  });

  test('validation failures never start a check or take the lock', async () => {
    for (const [email, password, configured] of [['', 'pw', true], ['a@b.c', '', true], ['a@b.c', 'pw', false]] as const) {
      const s = makeScreen({ getTurnstileToken: async () => ({ ok: true, token: 'T' }), email, password, configured });
      await s.run();
      assert.equal(s.state.tokenCalls, 0);
      assert.equal(s.state.loading.length, 0);
      assert.equal(s.submitting.current, false);
    }
  });

  test('18. CAPTCHA stays mandatory: no failure result of any kind ever reaches signIn', async () => {
    const reasons = ['cancelled', 'no_token', 'challenge_failed', 'timeout'];
    for (const reason of reasons) {
      const s = makeScreen({ getTurnstileToken: async () => ({ ok: false, reason }) });
      await s.run();
      assert.equal(s.state.signInCalls.length, 0, `reason=${reason}`);
    }
    // ...including a rejected challenge, and every hosted failure via the real helper.
    const rejected = makeScreen({ getTurnstileToken: async () => { throw new Error('x'); } });
    await rejected.run();
    assert.equal(rejected.state.signInCalls.length, 0);
    for (const qs of ['error=challenge_expired', 'error=script_load_timeout', 'error=init_failed', 'token=', '']) {
      const { mod } = makeTurnstile(async () => hostedReturn(qs));
      const s = makeScreen({ getTurnstileToken: mod.getTurnstileToken });
      await s.run();
      assert.equal(s.state.signInCalls.length, 0, `hosted return "${qs}"`);
    }
  });

  test('18b. the token reaches Supabase as options.captchaToken, unmodified', async () => {
    const seen: any[] = [];
    const contextSignIn = makeContextSignIn(async (args) => { seen.push(args); return { data: {}, error: null }; });
    await contextSignIn('a@b.c', 'pw', 'THE-TOKEN');
    assert.deepEqual(seen, [{ email: 'a@b.c', password: 'pw', options: { captchaToken: 'THE-TOKEN' } }]);
  });

  test('the timeout wording is exactly the specified copy, used for both deadlines', () => {
    assert.deepEqual(extractConst(SIGN_IN_SRC, 'TIMEOUT_ALERT'), {
      title: 'Sign in is taking too long',
      message: 'Please check your connection and try again. If the problem continues, close and reopen OneShetland.',
    });
  });
});

/* ── 15, 16. fresh install vs restored session ──────────────────────────── */

describe('session bootstrap — the real SecureStore adapter under the real supabase-js client', () => {
  const URL_ = 'https://testref.supabase.co';
  const KEY = 'sb-testref-auth-token';

  function fakeKeychain(seed: Record<string, string> = {}) {
    const m = new Map(Object.entries(seed));
    const calls = { get: 0, set: 0, del: 0 };
    return {
      m, calls,
      store: {
        getItemAsync: async (k: string) => { calls.get++; return m.get(k) ?? null; },
        setItemAsync: async (k: string, v: string) => { calls.set++; m.set(k, v); },
        deleteItemAsync: async (k: string) => { calls.del++; m.delete(k); },
      },
    };
  }

  function client(storage: any) {
    const net = { calls: 0 };
    const sb = createClient(URL_, 'anon-key', {
      auth: { storage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (async () => { net.calls++; throw new Error('the network must not be touched'); }) as any },
    });
    return { sb, net };
  }

  const session = () => ({
    access_token: 'aaa.bbb.ccc',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: {
      id: 'user-1', aud: 'authenticated', role: 'authenticated', email: 'restored@example.com',
      app_metadata: {}, user_metadata: { pad: 'x'.repeat(5000) }, created_at: '2026-01-01T00:00:00Z',
    },
  });

  test('15. a brand-new install (no keys at all) reads as "no session" — normal, immediate, no network', async () => {
    const kc = fakeKeychain();
    const storage = createChunkedSecureStorage(kc.store);
    assert.equal(await storage.getItem(KEY), null);

    const { sb, net } = client(storage);
    const started = Date.now();
    const { data, error } = await sb.auth.getSession();
    assert.equal(error, null);
    assert.equal(data.session, null);
    assert.ok(Date.now() - started < 1000, 'resolves promptly instead of waiting on anything');
    assert.equal(net.calls, 0);
  });

  test('15b. a session whose chunks are partly missing is treated as no session, not as a hang or crash', async () => {
    const kc = fakeKeychain({ [KEY]: '__chunks__:3', [`${KEY}.0`]: 'aaa', [`${KEY}.2`]: 'ccc' });
    const storage = createChunkedSecureStorage(kc.store);
    assert.equal(await storage.getItem(KEY), null);
    const { sb } = client(storage);
    assert.equal((await sb.auth.getSession()).data.session, null);
  });

  test('16. an existing (chunked) session is restored intact — no network, same user', async () => {
    const kc = fakeKeychain();
    const storage = createChunkedSecureStorage(kc.store);
    await storage.setItem(KEY, JSON.stringify(session()));
    assert.match(kc.m.get(KEY)!, /^__chunks__:\d+$/, 'this session is large enough to exercise chunking');

    const { sb, net } = client(storage);
    const { data } = await sb.auth.getSession();
    assert.equal(data.session?.user.id, 'user-1');
    assert.equal(data.session?.access_token, 'aaa.bbb.ccc');
    assert.equal(net.calls, 0, 'a still-valid session needs no refresh');
  });

  test('16b. a small (single-value) session round-trips too, and removeItem leaves nothing behind', async () => {
    const kc = fakeKeychain();
    const storage = createChunkedSecureStorage(kc.store);
    const small = { ...session(), user: { ...session().user, user_metadata: {} } };
    await storage.setItem(KEY, JSON.stringify(small));
    assert.equal(JSON.parse((await storage.getItem(KEY))!).user.id, 'user-1');
    await storage.removeItem(KEY);
    assert.equal(kc.m.size, 0);
    assert.equal(await storage.getItem(KEY), null);
  });

  test('16c. overwriting a large session with a smaller one leaves no stale chunks', async () => {
    const kc = fakeKeychain();
    const storage = createChunkedSecureStorage(kc.store);
    await storage.setItem(KEY, 'x'.repeat(6000));
    await storage.setItem(KEY, 'short');
    assert.deepEqual([...kc.m.keys()], [KEY]);
    assert.equal(await storage.getItem(KEY), 'short');
  });

  test('AuthContext still ends the loading gate on every bootstrap outcome (session / none / storage error)', () => {
    const ctx = code(AUTH_CTX_SRC);
    const boot = ctx.slice(ctx.indexOf('supabase.auth.getSession()'), ctx.indexOf('const {\n      data: { subscription }'));
    assert.match(boot, /if \(session\) \{\s*fetchProfile\(session\.user\.id\);\s*\} else \{\s*setLoading\(false\);\s*\}/);
    assert.match(boot, /\.catch\(\(err\) => \{[\s\S]*?setLoading\(false\);\s*\}\);/);
  });

  test('lib/supabase.ts still hands supabase-js the extracted adapter on native and AsyncStorage on web', () => {
    const src = code(readRepo('lib/supabase.ts'));
    assert.match(src, /const SecureStoreAdapter = createChunkedSecureStorage\(SecureStore\);/);
    assert.match(src, /const authStorage = Platform\.OS === 'web' \? AsyncStorage : SecureStoreAdapter;/);
    assert.match(src, /persistSession: true/);
  });
});

/* ── 17. diagnostics: which stage, and nothing sensitive ────────────────── */

describe('auth-stage diagnostics', () => {
  const SECRETS = [
    'Person@Example.com', 'person@example.com', 'hunter2-secret',
    'TOK-SECRET-XYZ', 'ACCESS-SECRET-111', 'REFRESH-SECRET-222', 'Bearer ', 'sb-testref-auth-token',
  ];

  /** Captures every byte any sink or console channel receives. */
  function capture() {
    const lines: string[] = [];
    const tracked: [string, Record<string, unknown>][] = [];
    const consoleOut: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    const sink = (...a: unknown[]) => consoleOut.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    console.log = console.warn = console.error = console.info = sink as never;
    const logger = createAuthStageLogger({
      log: (l) => lines.push(l),
      track: (n, p) => tracked.push([n, p as Record<string, unknown>]),
    });
    return {
      logger, lines, tracked, consoleOut,
      restore: () => Object.assign(console, orig),
      everything: () => JSON.stringify([lines, tracked, consoleOut]),
    };
  }

  /** Runs a whole attempt through the real helper + real handler + real signIn. */
  async function attempt(cap: ReturnType<typeof capture>, opts: { hosted: any; supabase: () => Promise<any> }) {
    const turnstile = loadModule('lib/turnstile.ts', {
      'react-native': { Platform: { OS: 'ios' } },
      'expo-web-browser': { openAuthSessionAsync: async () => opts.hosted, dismissAuthSession() {} },
      './with-deadline': { withDeadline, TIMED_OUT },
      './auth-diagnostics': { logAuthStage: cap.logger },
    });
    const signIn = instantiate(extractFunction(AUTH_CTX_SRC, 'async function signIn('), {
      supabase: { auth: { signInWithPassword: opts.supabase } },
      withDeadline, TIMED_OUT, SIGN_IN_TIMEOUT_MS: 30_000, logAuthStage: cap.logger, classifyAuthError,
    });
    const screen = makeScreen({
      getTurnstileToken: turnstile.getTurnstileToken,
      signIn: signIn as never,
      logs: [],
    });
    // Route the screen's own stage events through the capturing logger as well.
    const run = instantiate<() => Promise<void>>(extractFunction(SIGN_IN_SRC, 'async function handleSignIn'), {
      isSupabaseConfigured: true, email: ' Person@Example.com ', password: 'hunter2-secret',
      setError: () => {}, setLoading: () => {}, submitting: { current: false }, alert: () => {},
      TIMEOUT_ALERT: extractConst(SIGN_IN_SRC, 'TIMEOUT_ALERT'), logAuthStage: cap.logger,
      getTurnstileToken: turnstile.getTurnstileToken, signIn,
    });
    void screen;
    await run();
  }

  const okHosted = { type: 'success', url: 'oneshetland-fetch://turnstile-callback?token=TOK-SECRET-XYZ' };

  test('17. a successful sign-in records every stage in order and leaks nothing sensitive', async () => {
    const cap = capture();
    try {
      await attempt(cap, {
        hosted: okHosted,
        supabase: async () => ({ data: { session: { access_token: 'ACCESS-SECRET-111', refresh_token: 'REFRESH-SECRET-222' } }, error: null }),
      });
    } finally { cap.restore(); }

    assert.deepEqual(cap.tracked.map(([n]) => n), [
      'auth_submit_started', 'captcha_session_started', 'captcha_session_completed',
      'supabase_signin_started', 'supabase_signin_completed',
    ]);
    const blob = cap.everything();
    for (const secret of SECRETS) assert.ok(!blob.includes(secret), `leaked: ${secret}`);
  });

  test('17b. an invalid-credentials failure is bucketed — the server message (which can echo the email) is never logged', async () => {
    const cap = capture();
    try {
      await attempt(cap, {
        hosted: okHosted,
        supabase: async () => ({ data: {}, error: { message: 'Invalid login credentials for Person@Example.com' } }),
      });
    } finally { cap.restore(); }
    const failed = cap.tracked.find(([n]) => n === 'auth_failed');
    assert.equal(failed?.[1].reason, 'invalid_credentials');
    for (const secret of SECRETS) assert.ok(!cap.everything().includes(secret), `leaked: ${secret}`);
  });

  test('17c. captcha timeout / failure paths are recorded distinctly and leak nothing', async () => {
    for (const [hosted, expected] of [
      [{ type: 'success', url: 'oneshetland-fetch://turnstile-callback?error=script_load_timeout' }, ['captcha_timed_out', 'auth_timed_out']],
      [{ type: 'success', url: 'oneshetland-fetch://turnstile-callback?error=challenge_expired' }, ['captcha_failed']],
      [{ type: 'cancel' }, ['captcha_failed']],
    ] as const) {
      const cap = capture();
      try { await attempt(cap, { hosted, supabase: async () => { throw new Error('must not be reached'); } }); }
      finally { cap.restore(); }
      const names = cap.tracked.map(([n]) => n);
      for (const e of expected) assert.ok(names.includes(e), `${e} in ${names.join(',')}`);
      assert.ok(!names.includes('supabase_signin_started'), 'no Supabase call without a token');
      for (const secret of SECRETS) assert.ok(!cap.everything().includes(secret));
    }
  });

  test('17d. only allow-listed stage names and prop keys can ever be emitted', async () => {
    const cap = capture();
    try {
      await attempt(cap, { hosted: okHosted, supabase: async () => ({ data: {}, error: { message: 'boom' } }) });
    } finally { cap.restore(); }
    for (const [name, props] of cap.tracked) {
      assert.ok((AUTH_STAGES as readonly string[]).includes(name), name);
      for (const k of Object.keys(props)) assert.ok(['phase', 'reason', 'elapsed_ms'].includes(k), `${name}: ${k}`);
    }
  });

  test('17e. the redactor drops anything not on the allow-list, even if a caller tries to pass it', () => {
    assert.deepEqual(
      authStageProps({
        phase: 'launch', reason: 'ok', elapsedMs: 12.6,
        email: 'a@b.c', password: 'pw', token: 'tok', session: { access_token: 'x' }, headers: { authorization: 'Bearer x' },
      }),
      { phase: 'launch', reason: 'ok', elapsed_ms: 13 },
    );
    assert.deepEqual(authStageProps({ reason: 'a@b.c', phase: 'Bearer abc', elapsedMs: -1 }), {}, 'off-list values are dropped, not passed through');
    assert.deepEqual(authStageProps({ elapsedMs: Infinity }), {});
    assert.deepEqual(authStageProps(undefined), {});
    assert.deepEqual(authStageProps('a@b.c'), {});
  });

  test('17f. classifyAuthError returns a bucket, never the message', () => {
    assert.equal(classifyAuthError(null), 'ok');
    assert.equal(classifyAuthError('Invalid login credentials'), 'invalid_credentials');
    assert.equal(classifyAuthError('Email not confirmed'), 'email_not_confirmed');
    assert.equal(classifyAuthError('User a@b.c is banned'), 'other');
  });

  test('a throwing sink can never break sign-in', () => {
    const logger = createAuthStageLogger({ log: () => { throw new Error('log'); }, track: () => { throw new Error('track'); } });
    assert.doesNotThrow(() => logger('auth_submit_started'));
  });

  test('17g. no call site passes anything sensitive to logAuthStage (source scan of every emitter)', () => {
    const forbidden = /\b(email|password|captchaToken|access_token|refresh_token|accessToken|refreshToken|authorization|headers?)\b|\.message\b|\.token\b|\.data\b|\.user\b/;
    const files = ['lib/turnstile.ts', 'context/AuthContext.tsx', 'app/(auth)/sign-in.tsx'];
    let calls = 0;
    for (const f of files) {
      const src = code(readRepo(f));
      for (const m of src.matchAll(/logAuthStage\(\s*'([a-z_]+)'\s*(?:,\s*(\{[\s\S]*?\}))?\s*\)/g)) {
        calls++;
        assert.ok((AUTH_STAGES as readonly string[]).includes(m[1]), `${f}: unknown stage ${m[1]}`);
        if (m[2]) {
          assert.doesNotMatch(m[2], forbidden, `${f}: ${m[1]} passes something sensitive: ${m[2]}`);
          const keys = [...m[2].matchAll(/^\s*(\w+):/gm)].map((k) => k[1]);
          for (const k of keys) assert.ok(['phase', 'reason', 'elapsedMs'].includes(k), `${f}: ${m[1]} key ${k}`);
        }
      }
    }
    assert.ok(calls >= 12, `expected to find the emitters, found ${calls}`);
  });

  test('every requested stage is emitted from somewhere in the sign-in path', () => {
    const all = ['lib/turnstile.ts', 'context/AuthContext.tsx', 'app/(auth)/sign-in.tsx'].map((f) => code(readRepo(f))).join('\n');
    for (const stage of AUTH_STAGES) assert.match(all, new RegExp(`logAuthStage\\('${stage}'`), stage);
  });

  test('the diagnostics use the existing channels: a [OneShetland] console line and the first-party track()', () => {
    const wiring = code(readRepo('lib/auth-diagnostics.ts'));
    assert.match(wiring, /import \{ track \} from '\.\/analytics';/);
    assert.match(wiring, /log: \(line\) => console\.log\(line\)/);
    assert.match(wiring, /track: \(eventName, props\) => track\(eventName, \{ props \}\)/);
    const line: string[] = [];
    createAuthStageLogger({ log: (l) => line.push(l), track: () => {} })('captcha_failed', { reason: 'cancelled', elapsedMs: 40 });
    assert.deepEqual(line, ['[OneShetland] auth:captcha_failed reason=cancelled elapsed_ms=40']);
  });
});

/* ── source-shape guards for what the behaviour above relies on ─────────── */

describe('structure the behavioural tests rely on', () => {
  test('everything after setLoading(true) is inside try, and finally clears loading', () => {
    const body = code(extractFunction(SIGN_IN_SRC, 'async function handleSignIn'));
    assert.ok(body.indexOf('setLoading(true)') < body.indexOf('try {'));
    assert.ok(body.indexOf('try {') < body.indexOf('await getTurnstileToken()'));
    assert.match(body, /\} finally \{\s*submitting\.current = false;\s*setLoading\(false\);\s*\}/);
  });

  test('the challenge helper never throws: its only awaits are inside try/catch', () => {
    const src = code(TURNSTILE_SRC);
    const run = src.slice(src.indexOf('async function runChallenge'), src.indexOf('export async function getTurnstileToken'));
    assert.match(run, /^async function runChallenge[\s\S]*?\{\s*try \{/);
    // UPDATE — the physical-failure follow-up: the catch now distinguishes a
    // native "session could not be started" rejection ('unavailable') from any
    // other ('challenge_failed'). Still never throws, still always ok:false.
    assert.match(run, /\} catch \(err\) \{[\s\S]*?return \{ ok: false, reason: isSessionFailedToStart\(err\) \? 'unavailable' : 'challenge_failed' \};\s*\}\s*\}\s*$/);
    assert.doesNotMatch(run.slice(run.indexOf('} catch (err) {')), /ok: true|throw /);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   THE PHYSICAL FAILURE — 19 Sep 2026, ~10:35 UK, fresh TestFlight install.

   Production diagnostics for that attempt (allow-listed events only):
     session_bootstrap_started/completed  reason=no_session  (normal, ~5ms)
     auth_submit_started
     captcha_session_started
       … nothing …
     captcha_timed_out   reason=app_deadline  elapsed_ms=30003
     auth_timed_out      reason=captcha
   No captcha_session_completed, no captcha_failed, no hosted-page timeout
   report (the page would have redirected with ?error= at 25s), and never
   supabase_signin_started. The native openAuthSessionAsync() promise did not
   settle at all.

   The mechanism this pins: expo-web-browser < 55.0.19 (iOS) called
   ASWebAuthenticationSession.start() and IGNORED its Bool result. When start()
   returns false the completion handler never runs, so the JS promise stays
   pending for ever (upstream expo/expo#47653, fixed by #47896). 55.0.19+
   rejects with WebAuthSessionFailedToStartException instead.

   What this file can and cannot show: it proves the app now (a) refuses to
   ship a module that ignores start(), (b) turns the rejection into a fast,
   distinct, retryable failure, and (c) still bounds a session that never
   settles. It does NOT prove start() returned false on that phone — that was
   not observable from telemetry — nor why it would; upstream never reproduced
   that either.
   ══════════════════════════════════════════════════════════════════════════ */

describe('a native auth session that cannot start', () => {
  const failedToStart = () => Object.assign(new Error('The authentication session could not be started.'), {
    code: 'ERR_WEB_AUTH_SESSION_FAILED_TO_START',
  });

  test('settles immediately as `unavailable` — no 30s wait, no timer left running, never a token', async () => {
    const before = timers();
    const { mod, logs, native } = makeTurnstile(() => Promise.reject(failedToStart()));
    const r = await mod.getTurnstileToken();
    assert.deepEqual(r, { ok: false, reason: 'unavailable' });
    assert.ok(!('token' in r));
    assert.equal(native.opens, 1);
    assert.deepEqual(logs.map((l) => l[0]), ['captcha_session_started', 'captcha_failed']);
    assert.equal(logs[1][1]?.reason, 'unavailable');
    assert.equal(timers(), before, 'the deadline timer is cleared');
  });

  test('recognised by message alone too, in case a wrapper drops the error code', async () => {
    const { mod } = makeTurnstile(() => Promise.reject(new Error('The authentication session could not be started.')));
    assert.deepEqual(await mod.getTurnstileToken(), { ok: false, reason: 'unavailable' });
  });

  test('any OTHER native rejection stays an ordinary challenge failure', async () => {
    const { mod, logs } = makeTurnstile(() => Promise.reject(new Error('something else')));
    assert.deepEqual(await mod.getTurnstileToken(), { ok: false, reason: 'challenge_failed' });
    assert.equal(logs.at(-1)?.[1]?.reason, 'challenge_failed');
  });

  test('a session that neither starts nor fails (the OLD module\'s behaviour) is still bounded at 30s', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { mod } = makeTurnstile(() => new Promise(() => {}));
    let settled: any = null;
    void mod.getTurnstileToken().then((r: unknown) => { settled = r; });
    t.mock.timers.tick(30_000);
    await flush();
    assert.deepEqual(settled, { ok: false, reason: 'timeout' });
  });

  test('`unavailable` is on the diagnostics allow-list, and only as a fixed reason', () => {
    assert.deepEqual(authStageProps({ reason: 'unavailable', elapsedMs: 12, email: 'a@b.c', token: 'x' }), { reason: 'unavailable', elapsed_ms: 12 });
  });

  test('sign-in screen: the spinner clears, no password sign-in is attempted, and the person can retry', async () => {
    const logs: Log[] = [];
    const { run, state, submitting } = makeScreen({ getTurnstileToken: async () => ({ ok: false, reason: 'unavailable' }), logs });
    await run();
    assert.equal(lastLoading(state), false);
    assert.equal(state.signInCalls.length, 0, 'CAPTCHA is mandatory: no token, no password auth');
    assert.equal(state.alerts.length, 0, 'not the timeout dialog — this failed fast');
    assert.equal(state.errors.at(-1), "Couldn't complete the verification check. Please try again.");
    assert.equal(submitting.current, false);
  });

  test('sensitive values never reach a diagnostic sink on this path', async () => {
    const logs: Log[] = [];
    const { mod } = makeTurnstile(() => Promise.reject(failedToStart()));
    await mod.getTurnstileToken();
    const s = JSON.stringify(logs);
    assert.doesNotMatch(s, /token|password|email|session/i);
  });
});

describe('the native module the TestFlight build embeds must not ignore ASWebAuthenticationSession.start()', () => {
  const swift = readRepo('node_modules/expo-web-browser/ios/WebAuthSession.swift');
  const pkg = JSON.parse(readRepo('node_modules/expo-web-browser/package.json'));
  const semverGte = (v: string, min: string) => {
    const a = v.split('.').map(Number), b = min.split('.').map(Number);
    for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); }
    return true;
  };

  test('the installed iOS source checks start()\'s result and rejects when it is false', () => {
    assert.match(swift, /guard authSession\?\.start\(\) == true else \{\s*\n\s*promise\.reject\(WebAuthSessionFailedToStartException\(\)\)/);
    // The failure mode itself: a bare, unchecked start() followed by holding the promise.
    assert.doesNotMatch(swift, /^\s*authSession\?\.start\(\)\s*$/m);
  });

  test('installed version is 55.0.19 or later, and package.json cannot resolve below it', () => {
    assert.ok(semverGte(pkg.version, '55.0.19'), `installed ${pkg.version}`);
    const range = JSON.parse(readRepo('package.json')).dependencies['expo-web-browser'] as string;
    assert.ok(semverGte(range.replace(/^[~^]/, ''), '55.0.19'), `range ${range}`);
  });

  test('the fixed exception exists natively', () => {
    assert.match(readRepo('node_modules/expo-web-browser/ios/WebBrowserExceptions.swift'), /WebAuthSessionFailedToStartException/);
  });
});
