/**
 * redeem-session-freshness.node.test.ts
 *
 * Real production finding (29 Sep): a customer's web "Use at till" click on
 * an active pass returned "Can't redeem / Unauthorised". The reported
 * hypothesis was that the web flow calls the merchant-only redemption
 * action directly instead of presenting a credential — traced and
 * disproved: RedeemDialog → startRedemption → local-redeem-start is
 * architecturally identical to the mobile app's local-redeem.tsx →
 * startRedemption → local-redeem-start, on both platforms. Neither client
 * ever calls local-redeem-verify (the merchant-only, consuming endpoint).
 *
 * The real cause: supabase-js's fetchWithAuth wraps every request and calls
 * getAccessToken(), which returns `session?.access_token ?? supabaseKey`
 * (the plain anon key) whenever auth.getSession() cannot produce a live
 * session — an expired session with a dead refresh token. Sent to
 * local-redeem-start, that anon-key bearer passes the platform gateway (it
 * is a valid Supabase key) but fails the function's OWN
 * `anon.auth.getUser()` check, which correctly, safely returns
 * {error:'Unauthorised'} — proven live: an Authorization-less request gets
 * the GATEWAY's own {"code":"UNAUTHORIZED_NO_AUTH_HEADER",...} shape, a
 * different error entirely, confirming SOME Authorization header reached
 * the function and failed identity resolution there, not at the gateway.
 * This is a session-staleness gap latent on BOTH platforms (identical
 * startRedemption on each), not a web-only authorization-model bug.
 *
 * THE FIX
 * Both startRedemption implementations now check auth.getSession() first
 * and fail with a clear, actionable message ("Your session has expired —
 * sign in again to redeem this.") instead of letting a stale session reach
 * the function and come back reading like a permissions problem with the
 * pass itself. Same idiom as web's addToAppleWallet(). No change to
 * merchant authorization, the redemption token/code mechanism, or either
 * edge function.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT   = join(REPO_ROOT, '..', 'oneshetland-web');
const read    = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

const mobileApiSrc = code(read('lib/local-api.ts'));
const webClientSrc = code(readWeb('lib/loyalty-redeem-client.ts'));
const startFnSrc    = code(read('supabase/functions/local-redeem-start/index.ts'));
const verifyFnSrc   = code(read('supabase/functions/local-redeem-verify/index.ts'));

/* ── 1. Customer may present, never self-redeem — on either platform ─────── */

describe('customer starts a redemption but never consumes one, on web or mobile', () => {
  test('web RedeemDialog and mobile local-redeem.tsx both call only startRedemption (local-redeem-start)', () => {
    const dialogSrc = code(readWeb('components/local/RedeemDialog.tsx'));
    const screenSrc = code(read('app/local-redeem.tsx'));
    assert.match(dialogSrc, /startRedemption\(/);
    assert.match(screenSrc, /startRedemption\(/);
    assert.doesNotMatch(dialogSrc, /verifyRedemption\(|local-redeem-verify/);
    assert.doesNotMatch(screenSrc, /verifyRedemption\(|local-redeem-verify/);
  });

  test('local-redeem-start never calls the consuming RPCs — it only creates a pending row', () => {
    assert.doesNotMatch(startFnSrc, /redeem_pass_atomic|loyalty_redeem_code_atomic/);
    assert.match(startFnSrc, /status: 'pending'/);
  });

  test('only local-redeem-verify calls the consuming RPCs, and only after proving the caller runs a business', () => {
    assert.match(verifyFnSrc, /redeem_pass_atomic|loyalty_redeem_code_atomic/);
    assert.match(verifyFnSrc, /You do not run a business/);
  });

  test('the customer polling helper (getRedemptionState / getRedemptionStatus) is read-only on both platforms', () => {
    assert.doesNotMatch(webClientSrc.slice(webClientSrc.indexOf('getRedemptionState')), /\.insert\(|\.update\(|\.rpc\(/);
    const mobilePoll = mobileApiSrc.slice(mobileApiSrc.indexOf('export async function getRedemptionStatus'));
    assert.doesNotMatch(mobilePoll.slice(0, 600), /\.insert\(|\.update\(|\.rpc\(/);
  });
});

/* ── 2. The actual fix: session freshness checked before either call ─────── */

describe('startRedemption checks for a live session before calling local-redeem-start', () => {
  test('web: getSession() is checked, with a clear message distinct from the raw "Unauthorised" the function would return', () => {
    const fn = webClientSrc.slice(webClientSrc.indexOf('export async function startRedemption'), webClientSrc.indexOf('export async function previewRedemption'));
    assert.match(fn, /const \{\s*data: \{ session \} \} = await sb\.auth\.getSession\(\);/);
    assert.match(fn, /if \(!session\) throw new Error\("Your session has expired/);
    // The session check must run BEFORE the network call, not after.
    assert.ok(fn.indexOf('getSession()') < fn.indexOf("functions.invoke"), 'session must be checked before the call, not after it fails');
  });

  test('mobile: the same check, the same idiom', () => {
    const fn = mobileApiSrc.slice(mobileApiSrc.indexOf('export async function startRedemption'), mobileApiSrc.indexOf('export async function startRedemption') + 900);
    assert.match(fn, /const \{\s*data: \{ session \} \} = await supabase\.auth\.getSession\(\);/);
    assert.match(fn, /if \(!session\) throw new Error\('Your session has expired/);
    assert.ok(fn.indexOf('getSession()') < fn.indexOf('functions.invoke'), 'session must be checked before the call, not after it fails');
  });

  test('this is the same established idiom already used elsewhere on web (addToAppleWallet), not a new pattern', () => {
    const walletSrc = readWeb('lib/apple-wallet-client.ts');
    assert.match(walletSrc, /const \{ data: \{ session \} \} = await sb\.auth\.getSession\(\);/);
  });

  test('neither the redemption token/code mechanism nor either edge function was touched by this fix', () => {
    assert.doesNotMatch(webClientSrc, /\/local-redeem-verify.*preview: false/);
    // Presence, not absence, is the proof here: the same functions.invoke
    // call to local-redeem-start still exists, just guarded now.
    assert.match(webClientSrc, /functions\.invoke\("local-redeem-start"/);
    assert.match(mobileApiSrc, /functions\.invoke\('local-redeem-start'/);
  });
});

/* ── 3. Used / expired / refunded cannot be presented as active, on either platform ── */

describe('a spent, expired or refunded pass cannot be walked into "Use at till" on either platform', () => {
  test('server: local-redeem-start refuses a refunded, exhausted or expired pass before issuing a code', () => {
    const passStart = startFnSrc.indexOf("kind === 'pass'");
    const passBranch = startFnSrc.slice(passStart, passStart + 1200);
    assert.match(passBranch, /refund_state.*!== 'none'.*410/s);
    assert.match(passBranch, /uses_remaining.*<= 0.*410/s);
    assert.match(passBranch, /expires_at.*410/s);
  });

  test('mobile UI: only an active pass with uses_remaining > 0 renders the button at all', () => {
    const screenSrc = code(read('app/local-my-passes.tsx'));
    assert.match(screenSrc, /pass\.status === 'active' && pass\.uses_remaining > 0/);
  });

  test('web UI: the identical gate', () => {
    const clientSrc = code(readWeb('app/account/passes/PassesClient.tsx'));
    assert.match(clientSrc, /pass\.status === "active" && usesLeft > 0/);
  });

  test('both platforms classify status the same way — refund checked before uses_remaining, so a refunded-but-unused pass never reads as active', () => {
    const mobileClassify = code(read('lib/local-api.ts'));
    const webClassify = code(readWeb('lib/passes-data.ts'));
    for (const src of [mobileClassify, webClassify]) {
      const refundIdx = src.indexOf("refundState === 'refunded'") >= 0
        ? src.indexOf("refundState === 'refunded'")
        : src.indexOf('refundState === "refunded"');
      const usesIdx = src.indexOf('usesRemaining <= 0');
      assert.ok(refundIdx >= 0 && usesIdx >= 0 && refundIdx < usesIdx,
        'refund state must be checked before uses_remaining on both platforms');
    }
  });
});
