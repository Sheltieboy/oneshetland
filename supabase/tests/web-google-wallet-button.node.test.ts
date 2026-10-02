/**
 * web-google-wallet-button.node.test.ts
 *
 * Clicking "Add to Google Wallet" on the web account/loyalty page did nothing at all:
 * no tab, no message, no error. The page showed any THROWN error, so nothing was thrown.
 * The old code fetched the signed save link and only THEN called window.open. A window
 * opened after a network round trip is no longer "directly triggered by the click", so the
 * browser silently blocks it — window.open returns null, no exception — and the customer
 * sees nothing.
 *
 * The fix opens the destination tab SYNCHRONOUSLY in the click and sends it to the link
 * when it arrives; if even that is blocked, the current tab goes to the link. Failures
 * always become a visible, customer-safe message.
 *
 * This runs the REAL client library (lib/google-wallet-client.ts) and the REAL click
 * handler from the loyalty page against fakes (a browser window that can block popups, a
 * session, a network). No real browser, network, Google or key material is involved.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule, extractFunction, instantiate } from './_support/load-source.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = '../oneshetland-web';
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SAVE = 'https://pay.google.com/gp/v/save/eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ4In0.c2lnbmF0dXJl';

/* ── a browser whose popup blocker behaves like the real one ──────────────── */

interface FakePopup { closed: boolean; opener: unknown; navigated: string[]; closeCalls: number; location: { replace: (u: string) => void }; close: () => void }
interface Env {
  events: string[];
  popups: FakePopup[];
  sameTabNavigations: string[];
  blockPopups: boolean;
  popupNavigationThrows: boolean;
  session: { access_token: string } | null;
  fetchImpl: (url: string, init: any) => Promise<Response>;
  fetchCalls: { url: string; init: any }[];
}
let env: Env;

const resp = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

function install() {
  env = {
    events: [], popups: [], sameTabNavigations: [], blockPopups: false, popupNavigationThrows: false,
    session: { access_token: 'USER-JWT' }, fetchCalls: [],
    fetchImpl: async () => resp(200, { saveUrl: SAVE }),
  };
  (globalThis as any).window = {
    open: (_url: string, _target: string) => {
      env.events.push('window.open');
      if (env.blockPopups) return null;           // exactly what a popup blocker does: null, no exception
      const p: FakePopup = {
        closed: false, opener: 'PAGE', navigated: [], closeCalls: 0,
        location: { replace: (u: string) => { if (env.popupNavigationThrows) throw new Error('blocked'); env.events.push('popup.replace'); p.navigated.push(u); } },
        close: () => { p.closed = true; p.closeCalls++; },
      };
      env.popups.push(p);
      return p;
    },
    location: { assign: (u: string) => { env.events.push('location.assign'); env.sameTabNavigations.push(u); } },
  };
  (globalThis as any).fetch = async (url: string, init: any) => { env.events.push('fetch'); env.fetchCalls.push({ url, init }); return env.fetchImpl(url, init); };
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'ANON';
}

const lib = () => loadModule(`${WEB}/lib/google-wallet-client.ts`, {
  '@/lib/supabase/client': { createClient: () => ({ auth: { getSession: async () => { env.events.push('getSession'); return { data: { session: env.session } }; } } }) },
});
let L: Record<string, any>;
beforeEach(() => { install(); L = lib(); });

/* ── the library ───────────────────────────────────────────────────────────── */

describe('the click opens the destination tab BEFORE any network round trip', () => {
  test('window.open is the FIRST thing that happens, synchronously inside the call, and nothing has been fetched yet', () => {
    const p = L.addToGoogleWallet();            // NOT awaited: only the synchronous part has run
    assert.equal(env.events[0], 'window.open', 'a tab opened later than the click is blocked by the browser');
    assert.equal(env.events.includes('fetch'), false, 'the tab must open before the round trip, not after it');
    return p;
  });

  test('the opened tab cannot reach back into the page (opener cleared)', async () => {
    await L.addToGoogleWallet();
    assert.equal(env.popups[0].opener, null);
  });
});

describe('success', () => {
  test('calls google-wallet-pass as the signed-in user, once', async () => {
    await L.addToGoogleWallet();
    assert.equal(env.fetchCalls.length, 1);
    const c = env.fetchCalls[0];
    assert.equal(c.url, 'https://proj.supabase.co/functions/v1/google-wallet-pass');
    assert.equal(c.init.method, 'POST');
    assert.equal(c.init.headers.Authorization, 'Bearer USER-JWT');
    assert.equal(c.init.headers.apikey, 'ANON');
  });

  test('the pre-opened tab is sent to the Google save link; nothing else navigates and nothing is closed', async () => {
    await L.addToGoogleWallet();
    assert.deepEqual(env.popups[0].navigated, [SAVE]);
    assert.deepEqual(env.sameTabNavigations, []);
    assert.equal(env.popups[0].closeCalls, 0);
    assert.deepEqual(env.events, ['window.open', 'getSession', 'fetch', 'popup.replace']);
  });

  test('POPUP BLOCKER: when even the synchronous open is blocked, the CURRENT tab goes to the link — one click, no error', async () => {
    env.blockPopups = true;
    await L.addToGoogleWallet();
    assert.deepEqual(env.sameTabNavigations, [SAVE]);
  });

  test('if navigating the new tab throws, it falls back to this tab rather than doing nothing', async () => {
    env.popupNavigationThrows = true;
    await L.addToGoogleWallet();
    assert.deepEqual(env.sameTabNavigations, [SAVE]);
  });
});

describe('failure is always visible and customer-safe', () => {
  const expectFailure = async (message: string) => {
    await assert.rejects(L.addToGoogleWallet(), (e: any) => {
      assert.equal(e.name, 'GoogleWalletError');
      assert.equal(e.message, message);
      return true;
    });
    assert.equal(env.popups[0]?.closeCalls, 1, 'the blank tab was left open');
    assert.deepEqual(env.sameTabNavigations, [], 'a failure must not navigate anywhere');
  };

  test('the function says the secret is not configured (500) → the generic line, and the raw text never reaches the customer', async () => {
    env.fetchImpl = async () => resp(500, { error: 'Google Wallet secret not configured' });
    await expectFailure(L.GOOGLE_WALLET_UNAVAILABLE);
    assert.equal(L.GOOGLE_WALLET_UNAVAILABLE, "Google Wallet isn't available right now. Please try again.");
  });

  test('a 200 with NO save link becomes visible, not silent', async () => {
    env.fetchImpl = async () => resp(200, {});
    await expectFailure(L.GOOGLE_WALLET_UNAVAILABLE);
    env.popups.length = 0; env.fetchImpl = async () => resp(200, { saveUrl: '' });
    await expectFailure(L.GOOGLE_WALLET_UNAVAILABLE);
  });

  test('a link that is not a Google Wallet save link is refused (no open redirect through a compromised response)', async () => {
    for (const bad of ['https://evil.example/gp/v/save/abc', 'javascript:alert(1)', 'http://pay.google.com/gp/v/save/abc', 'https://pay.google.com.evil.example/gp/v/save/abc', 'https://pay.google.com/gp/v/save/abc?next=https://evil.example', 42, null]) {
      env.popups.length = 0; env.sameTabNavigations.length = 0;
      env.fetchImpl = async () => resp(200, { saveUrl: bad });
      await expectFailure(L.GOOGLE_WALLET_UNAVAILABLE);
    }
  });

  test('no signed-in session → asks them to sign in, and never calls the function', async () => {
    env.session = null;
    await expectFailure(L.GOOGLE_WALLET_SIGN_IN);
    assert.equal(env.fetchCalls.length, 0);
  });

  test('an expired session (401) → asks them to sign in again', async () => {
    env.fetchImpl = async () => resp(401, { error: 'Unauthorised' });
    await expectFailure(L.GOOGLE_WALLET_SIGN_IN);
  });

  test('the network failing → the generic line', async () => {
    env.fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
    await expectFailure(L.GOOGLE_WALLET_UNAVAILABLE);
  });

  test('a request that never answers is abandoned (abort signal wired) rather than leaving "Preparing…" for ever', async () => {
    env.fetchImpl = async (_u, init) => { assert.ok(init.signal, 'no abort signal'); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
    await expectFailure(L.GOOGLE_WALLET_UNAVAILABLE);
  });

  test('a non-JSON error body is handled', async () => {
    env.fetchImpl = async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('x'); } }) as unknown as Response;
    await expectFailure(L.GOOGLE_WALLET_UNAVAILABLE);
  });

  test('no secret material can reach the client: messages are fixed strings, and the library never reads or returns key data', () => {
    for (const m of [L.GOOGLE_WALLET_UNAVAILABLE, L.GOOGLE_WALLET_SIGN_IN]) assert.doesNotMatch(m, /private|secret|key|BEGIN|iam\.gserviceaccount|service.?account/i);
    const src = code(read(`${WEB}/lib/google-wallet-client.ts`));
    assert.doesNotMatch(src, /GOOGLE_WALLET_SA_JSON|private_key|client_email|SERVICE_ROLE/);
  });
});

/* ── the real click handler on the loyalty page ────────────────────────────── */

describe('the Add to Google Wallet button on /account/loyalty', () => {
  const pageSrc = read(`${WEB}/app/account/loyalty/LoyaltyClient.tsx`);
  const runSrc = extractFunction(pageSrc, 'const run = async (which').replace(/^const run = /, '');

  function harness(google: () => Promise<void>, apple: () => Promise<void> = async () => {}) {
    const log: { name: string; arg: unknown }[] = [];
    const inFlight = { current: false };
    const scope = {
      inFlight,
      setErr: (v: unknown) => log.push({ name: 'setErr', arg: v }),
      setBusy: (v: unknown) => log.push({ name: 'setBusy', arg: v }),
      addToGoogleWallet: async () => { log.push({ name: 'google', arg: null }); return google(); },
      addToAppleWallet: async () => { log.push({ name: 'apple', arg: null }); return apple(); },
      GoogleWalletError: L.GoogleWalletError,
      GOOGLE_WALLET_UNAVAILABLE: L.GOOGLE_WALLET_UNAVAILABLE,
    };
    const run = instantiate<(w: 'apple' | 'google') => Promise<void>>(runSrc, scope);
    return { run, log, inFlight };
  }
  const last = (log: { name: string; arg: unknown }[], n: string) => [...log].reverse().find((x) => x.name === n)?.arg;

  test('a click invokes the function — synchronously, so the browser still counts the tab it opens as the customer\'s', async () => {
    const h = harness(async () => {});
    const p = h.run('google');
    assert.ok(h.log.some((x) => x.name === 'google'), 'the Google call was not made in the click\'s own turn');
    await p;
  });

  test('"Preparing…" state: busy is set to google, then cleared', async () => {
    const h = harness(async () => {});
    await h.run('google');
    assert.deepEqual(h.log.filter((x) => x.name === 'setBusy').map((x) => x.arg), ['google', null]);
    assert.equal(h.inFlight.current, false);
  });

  test('DUPLICATE CLICKS are ignored while preparing (even before React re-renders the button disabled)', async () => {
    let release!: () => void;
    let n = 0;
    // the first request stays pending until released; later ones answer at once
    const h = harness(() => (++n === 1 ? new Promise<void>((r) => { release = r; }) : Promise.resolve()));
    const first = h.run('google');
    await h.run('google'); await h.run('google');
    assert.equal(h.log.filter((x) => x.name === 'google').length, 1);
    release(); await first;
    await h.run('google');                       // usable again afterwards
    assert.equal(h.log.filter((x) => x.name === 'google').length, 2);
  });

  test('a failure becomes a VISIBLE message (setErr), the busy state clears, the button works again', async () => {
    const h = harness(async () => { throw new L.GoogleWalletError(L.GOOGLE_WALLET_UNAVAILABLE); });
    await h.run('google');
    assert.equal(last(h.log, 'setErr'), "Google Wallet isn't available right now. Please try again.");
    assert.equal(last(h.log, 'setBusy'), null);
    assert.equal(h.inFlight.current, false);
  });

  test('an UNEXPECTED error is replaced by the generic line — a raw error never reaches the customer', async () => {
    const h = harness(async () => { throw new Error('TypeError: cannot read private_key of undefined'); });
    await h.run('google');
    assert.equal(last(h.log, 'setErr'), L.GOOGLE_WALLET_UNAVAILABLE);
  });

  test('a sign-in problem is shown as such', async () => {
    const h = harness(async () => { throw new L.GoogleWalletError(L.GOOGLE_WALLET_SIGN_IN); });
    await h.run('google');
    assert.equal(last(h.log, 'setErr'), L.GOOGLE_WALLET_SIGN_IN);
  });

  test('the message is cleared at the start of the next attempt', async () => {
    const h = harness(async () => {});
    await h.run('google');
    assert.equal(h.log.find((x) => x.name === 'setErr')?.arg, null);
  });

  test('the Apple flow is unchanged: it still calls Apple, and keeps its own message', async () => {
    const ok = harness(async () => {}); await ok.run('apple');
    assert.equal(ok.log.some((x) => x.name === 'apple'), true);
    assert.equal(ok.log.some((x) => x.name === 'google'), false);
    const bad = harness(async () => {}, async () => { throw new Error('Could not create your Wallet pass.'); });
    await bad.run('apple');
    assert.equal(last(bad.log, 'setErr'), 'Could not create your Wallet pass.');
  });

  test('the markup: the button is disabled and reads "Preparing…" while busy; the message is an alert', () => {
    const s = code(pageSrc);
    assert.match(s, /onClick=\{\(\) => run\("google"\)\} disabled=\{busy !== null\}/);
    assert.match(s, /busy === "google" \? "Preparing…" : "Add to Google Wallet"/);
    assert.match(s, /\{err && <p role="alert"/);
  });

  test('REGRESSION GUARD: window.open is never called after an await in the client library', () => {
    const src = code(read(`${WEB}/lib/google-wallet-client.ts`));
    const body = src.slice(src.indexOf('export async function addToGoogleWallet'));
    const firstOpen = body.indexOf('window.open(');
    const firstAwait = body.indexOf('await ');
    assert.ok(firstOpen !== -1 && firstOpen < firstAwait, 'window.open must come before the first await');
    assert.equal((body.match(/window\.open\(/g) ?? []).length, 1);
  });
});
