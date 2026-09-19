/**
 * mobile-turnstile-challenge-page.node.test.ts
 *
 * The hosted page /mobile-turnstile-challenge (oneshetland-web) is what the app
 * opens in an auth session to get a Turnstile token. The app waits for ONE
 * thing — a redirect to oneshetland-fetch://turnstile-callback — and the page
 * used to redirect only on a token or the widget's error-callback. Expiry,
 * timeout and script-load failure left the session open indefinitely.
 *
 * These tests drive the page's real state machine
 * (oneshetland-web/lib/mobile-turnstile-challenge.ts) through every terminal
 * condition with a fake Cloudflare API and a manual scheduler, and assert:
 *   - each condition redirects exactly once, on the existing callback URL;
 *   - only a genuine token produces `?token=`; every other path produces
 *     `?error=<reason>` and NO token — timeout, expiry and script failure are
 *     never a pass.
 *
 * SAFETY: no network, no Cloudflare, no Supabase. Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startMobileChallenge,
  returnUrlFor,
  RETURN_SCHEME,
  SCRIPT_LOAD_TIMEOUT_MS,
  CHALLENGE_DEADLINE_MS,
} from '../../../oneshetland-web/lib/mobile-turnstile-challenge.ts';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'oneshetland-web');
const web = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');

/** A scheduler the test drives by hand — no real waiting. */
function manualClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn: () => void, ms: number) => { const id = nextId++; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (h: unknown) => { pending.delete(h as number); },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
    get pendingCount() { return pending.size; },
  };
}

type RenderOpts = Parameters<Parameters<typeof startMobileChallenge>[0]['getApi'] extends () => infer A ? NonNullable<A>['render'] : never>[1];

/**
 * Builds a page run. `script` decides how the Cloudflare script behaves;
 * `render` lets a test misbehave at widget-initialisation.
 */
function setup(opts: {
  siteKey?: string;
  script?: 'loads' | 'fails' | 'hangs';
  api?: 'ok' | 'missing';
  container?: boolean;
  render?: (o: RenderOpts) => string | null | undefined;
} = {}) {
  const clock = manualClock();
  const redirects: string[] = [];
  const settled: unknown[] = [];
  const removed: string[] = [];
  let widget: RenderOpts | null = null;

  const api = {
    render: (_c: unknown, o: RenderOpts) => {
      widget = o;
      return opts.render ? opts.render(o) : 'widget-1';
    },
    remove: (id?: string) => { if (id) removed.push(id); },
  };

  const run = startMobileChallenge({
    siteKey: opts.siteKey ?? 'PUBLIC_SITE_KEY',
    loadScript: () =>
      opts.script === 'fails' ? Promise.reject(new Error('blocked'))
      : opts.script === 'hangs' ? new Promise<void>(() => {})
      : Promise.resolve(),
    getApi: () => (opts.api === 'missing' ? undefined : (api as never)),
    getContainer: () => (opts.container === false ? null : ({} as HTMLElement)),
    redirect: (u) => redirects.push(u),
    onSettled: (o) => settled.push(o),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  const flush = () => new Promise((r) => setImmediate(r));
  return { clock, redirects, settled, removed, run, flush, widget: () => widget! };
}

const query = (url: string) => new URL(url).searchParams;
const isFailure = (url: string) => url.startsWith(`${RETURN_SCHEME}?error=`) && !query(url).has('token');

describe('hosted challenge — every terminal condition returns to the app', () => {
  test('1. success: a genuine token redirects back with that token', async () => {
    const t = setup();
    await t.flush();
    t.widget().callback('REAL.TOKEN-123');
    assert.equal(t.redirects.length, 1);
    assert.equal(t.redirects[0], `${RETURN_SCHEME}?token=REAL.TOKEN-123`);
    assert.deepEqual(t.settled, [{ token: 'REAL.TOKEN-123' }]);
    assert.deepEqual(t.removed, ['widget-1'], 'the widget is torn down once settled');
    assert.equal(t.clock.pendingCount, 0, 'no timer is left running');
  });

  test('2. Turnstile error-callback redirects back as a failure (existing reason kept)', async () => {
    const t = setup();
    await t.flush();
    t.widget()['error-callback']!();
    assert.deepEqual(t.redirects, [`${RETURN_SCHEME}?error=challenge_failed`]);
  });

  test('3. Turnstile timeout-callback redirects back as a failure', async () => {
    const t = setup();
    await t.flush();
    t.widget()['timeout-callback']!();
    assert.deepEqual(t.redirects, [`${RETURN_SCHEME}?error=challenge_timeout`]);
  });

  test('4. Turnstile expired-callback redirects back as a failure', async () => {
    const t = setup();
    await t.flush();
    t.widget()['expired-callback']!();
    assert.deepEqual(t.redirects, [`${RETURN_SCHEME}?error=challenge_expired`]);
  });

  test('5. script load error redirects back as a failure', async () => {
    const t = setup({ script: 'fails' });
    await t.flush();
    assert.deepEqual(t.redirects, [`${RETURN_SCHEME}?error=script_load_failed`]);
    assert.equal(t.clock.pendingCount, 0);
  });

  test('6. a script that never finishes loading times out and redirects back', async () => {
    const t = setup({ script: 'hangs' });
    await t.flush();
    t.clock.advance(SCRIPT_LOAD_TIMEOUT_MS - 1);
    assert.equal(t.redirects.length, 0, 'still within the load allowance');
    t.clock.advance(1);
    assert.deepEqual(t.redirects, [`${RETURN_SCHEME}?error=script_load_timeout`]);
  });

  test('a widget that never calls back at all is cut off by the overall deadline', async () => {
    const t = setup();
    await t.flush();
    t.clock.advance(CHALLENGE_DEADLINE_MS - 1);
    assert.equal(t.redirects.length, 0);
    t.clock.advance(1);
    assert.deepEqual(t.redirects, [`${RETURN_SCHEME}?error=challenge_timeout`]);
    assert.ok(CHALLENGE_DEADLINE_MS < 30_000, "the page must report before the app's own 30s deadline");
  });

  test('the script-load allowance is released once the script loads (it cannot fire later)', async () => {
    const t = setup();
    await t.flush();
    t.clock.advance(SCRIPT_LOAD_TIMEOUT_MS + 1);
    assert.equal(t.redirects.length, 0, 'script loaded, so only the overall deadline still applies');
  });
});

describe('hosted challenge — malformed / failed initialisation', () => {
  test('no site key (misconfigured build) fails immediately', () => {
    const t = setup({ siteKey: '' });
    assert.deepEqual(t.redirects, [`${RETURN_SCHEME}?error=init_failed`]);
    assert.equal(t.clock.pendingCount, 0, 'nothing left waiting');
  });

  test('window.turnstile missing after the script "loaded"', async () => {
    const t = setup({ api: 'missing' });
    await t.flush();
    assert.deepEqual(t.redirects, [`${RETURN_SCHEME}?error=init_failed`]);
  });

  test('no container element to render into', async () => {
    const t = setup({ container: false });
    await t.flush();
    assert.deepEqual(t.redirects, [`${RETURN_SCHEME}?error=init_failed`]);
  });

  test('render() throws', async () => {
    const t = setup({ render: () => { throw new Error('bad options'); } });
    await t.flush();
    assert.deepEqual(t.redirects, [`${RETURN_SCHEME}?error=init_failed`]);
  });

  test('render() returns no widget id', async () => {
    for (const bad of [undefined, null, '']) {
      const t = setup({ render: () => bad as never });
      await t.flush();
      assert.deepEqual(t.redirects, [`${RETURN_SCHEME}?error=init_failed`], `render() → ${String(bad)}`);
    }
  });

  test('unsupported-callback (browser cannot run the widget) is a failure', async () => {
    const t = setup();
    await t.flush();
    t.widget()['unsupported-callback']!();
    assert.deepEqual(t.redirects, [`${RETURN_SCHEME}?error=init_failed`]);
  });

  test('a callback that fires synchronously inside render() still redirects once and cleans up', async () => {
    const t = setup({ render: (o) => { o.callback('SYNC-TOKEN'); return 'widget-sync'; } });
    await t.flush();
    assert.deepEqual(t.redirects, [`${RETURN_SCHEME}?token=SYNC-TOKEN`]);
    assert.deepEqual(t.removed, ['widget-sync']);
  });
});

describe('hosted challenge — no failure path can produce a CAPTCHA token', () => {
  const failures: [string, (t: ReturnType<typeof setup>) => Promise<void> | void, Parameters<typeof setup>[0]?][] = [
    ['error-callback', (t) => t.widget()['error-callback']!()],
    ['timeout-callback', (t) => t.widget()['timeout-callback']!()],
    ['expired-callback', (t) => t.widget()['expired-callback']!()],
    ['unsupported-callback', (t) => t.widget()['unsupported-callback']!()],
    ['script load error', () => {}, { script: 'fails' }],
    ['script load timeout', (t) => t.clock.advance(SCRIPT_LOAD_TIMEOUT_MS), { script: 'hangs' }],
    ['overall deadline', (t) => t.clock.advance(CHALLENGE_DEADLINE_MS)],
    ['no site key', () => {}, { siteKey: '' }],
    ['no api', () => {}, { api: 'missing' }],
    ['render throws', () => {}, { render: () => { throw new Error('x'); } }],
    ['empty token', (t) => t.widget().callback('')],
    ['undefined token', (t) => t.widget().callback(undefined as never)],
  ];

  for (const [name, trigger, opts] of failures) {
    test(`7. ${name}: redirects as a failure with NO token`, async () => {
      const t = setup(opts);
      await t.flush();
      await trigger(t);
      assert.equal(t.redirects.length, 1, 'exactly one redirect');
      assert.ok(isFailure(t.redirects[0]), `expected an error redirect, got ${t.redirects[0]}`);
      assert.ok(!t.redirects[0].includes('token'), 'the URL must not carry a token');
      assert.ok(!t.settled.some((o) => o && typeof o === 'object' && 'token' in o));
    });
  }

  test('returnUrlFor writes `token` only for a { token } outcome', () => {
    for (const error of ['challenge_failed', 'challenge_timeout', 'challenge_expired', 'script_load_failed', 'script_load_timeout', 'init_failed'] as const) {
      assert.ok(!returnUrlFor({ error }).includes('token'), error);
    }
    assert.equal(returnUrlFor({ token: 'a b&c' }), `${RETURN_SCHEME}?token=a%20b%26c`);
  });

  test('a token that arrives AFTER a failure is ignored — the first outcome wins', async () => {
    const t = setup();
    await t.flush();
    t.widget()['timeout-callback']!();
    t.widget().callback('LATE-TOKEN');
    t.widget()['error-callback']!();
    assert.deepEqual(t.redirects, [`${RETURN_SCHEME}?error=challenge_timeout`]);
  });

  test('a failure that arrives AFTER a token cannot revoke it or redirect twice', async () => {
    const t = setup();
    await t.flush();
    t.widget().callback('GOOD');
    t.widget()['expired-callback']!();
    t.clock.advance(CHALLENGE_DEADLINE_MS * 2);
    assert.deepEqual(t.redirects, [`${RETURN_SCHEME}?token=GOOD`]);
  });

  test('unmounting stops everything without redirecting', async () => {
    const t = setup();
    await t.flush();
    t.run.stop();
    t.clock.advance(CHALLENGE_DEADLINE_MS * 2);
    assert.equal(t.redirects.length, 0);
    assert.deepEqual(t.removed, ['widget-1']);
  });
});

describe('the hosted page uses the existing callback contract and does not weaken Turnstile', () => {
  const page = web('app/mobile-turnstile-challenge/page.tsx');
  const controller = web('lib/mobile-turnstile-challenge.ts');
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('same return URL the app already listens on — no second protocol', () => {
    assert.equal(RETURN_SCHEME, 'oneshetland-fetch://turnstile-callback');
    assert.match(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib/turnstile.ts'), 'utf8'),
      /const RETURN_URL = 'oneshetland-fetch:\/\/turnstile-callback';/);
  });

  test('the page hands control to the controller and redirects via window.location', () => {
    assert.match(page, /startMobileChallenge\(\{/);
    assert.match(page, /window\.location\.href = url;/);
    assert.match(page, /siteKey: TURNSTILE_SITE_KEY/);
    assert.match(page, /return run\.stop;/);
  });

  test('the widget is still rendered with the public site key and Managed/interaction-only presentation', () => {
    assert.match(strip(controller), /sitekey: deps\.siteKey,\s*appearance: "interaction-only"/);
    assert.doesNotMatch(strip(controller), /secret/i);
    assert.doesNotMatch(strip(page), /secret/i);
  });

  test('the success path requires a non-empty string token — nothing else builds a { token } outcome', () => {
    const c = strip(controller);
    assert.equal((c.match(/settle\(\{ token \}\)/g) ?? []).length, 1);
    assert.match(c, /typeof token === "string" && token\.length > 0/);
  });

  test('the page no longer reuses the shared widget component (which cannot tell expiry from timeout) and keeps the website untouched', () => {
    assert.doesNotMatch(strip(page), /components\/ui\/Turnstile/);
  });
});
