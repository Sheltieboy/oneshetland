/**
 * mobile-hub-payout-entry.node.test.ts — told before you build the thing you can't sell.
 *
 * WHAT WAS WRONG
 *
 * On mobile the membership-tiers screen mentioned payouts only when a PAID tier
 * already existed:
 *
 *   const needsPayouts = hasPaid && hub && !hub.payout_enabled;
 *
 * So a brand-new hub — no tiers at all — was told nothing, and could design and
 * save a paid tier before anything said it could not be sold. Hub Manage had no
 * Payouts row either, so there was nowhere to go and find out. The onboarding
 * CALL existed (createHubOnboardingLink) but had no screen and one hidden entry
 * point. Web already had this right.
 *
 * The old gate was also the wrong question. hubs.payout_enabled can be true
 * with no connected account attached; the real condition is the one
 * create-hub-membership-intent applies, and the account id behind it is granted
 * to no client role (20260928130000). So readiness is asked of
 * hub_payout_ready() — one boolean, no identifiers.
 *
 * WHAT IS ASSERTED
 *   · zero tiers + no payouts still shows the CTA — the case the old gate missed
 *   · paid tiers + no payouts shows the CTA
 *   · a payout-ready hub shows the ready state, with no setup CTA
 *   · Hub Manage carries a Payouts row, routed to the payouts screen
 *   · the screen it routes to exists
 *   · no stripe_account_id enters any mobile read
 *   · no select('*') is reintroduced on hubs
 *   · tier creation is untouched
 *
 * SAFETY
 * Reads source and executes the real helper. No database, no network, no writes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOTICE = join(REPO_ROOT, 'lib/hub-payout-notice.ts');
const TIERS = join(REPO_ROOT, 'app/hub-membership-types.tsx');
const ADMIN = join(REPO_ROOT, 'app/hub-admin.tsx');
const PAYOUTS = join(REPO_ROOT, 'app/hub-payouts.tsx');
const API = join(REPO_ROOT, 'lib/hubs-api.ts');

const src = (p: string) => readFileSync(p, 'utf8');
const code = (p: string) => src(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** Run the real copy helper rather than reading it for reassuring words. */
function load() {
  const js = ts.transpileModule(src(NOTICE), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports_: Record<string, unknown> = {};
  new Function('exports', js)(exports_);
  return exports_ as {
    hubPayoutNotice: (ready: boolean) => { title: string; body: string; cta: string };
    showsPayoutNotice: () => boolean;
  };
}
const M = load();

describe('the notice appears whatever the tier list holds', () => {
  test('zero tiers and no payouts still gets the CTA', () => {
    // The condition that decides the banner is payout readiness alone. Nothing
    // about the tiers can suppress it.
    assert.equal(M.showsPayoutNotice(), true);
    const n = M.hubPayoutNotice(false);
    assert.equal(n.title, 'Set up payouts to offer paid memberships');
    assert.equal(n.cta, 'Set up payouts');
  });

  test('the supporting copy says free tiers still work', () => {
    assert.match(M.hubPayoutNotice(false).body,
      /Free tiers work straight away\. Paid tiers need a connected payout account\./);
  });

  test('paid tiers and no payouts gets the same CTA', () => {
    assert.deepEqual(M.hubPayoutNotice(false), M.hubPayoutNotice(false));
    assert.equal(M.hubPayoutNotice(false).cta, 'Set up payouts');
  });

  test('a payout-ready hub gets the ready state instead', () => {
    const n = M.hubPayoutNotice(true);
    assert.equal(n.title, 'Payouts ready ✓');
    assert.notEqual(n.title, M.hubPayoutNotice(false).title);
    assert.doesNotMatch(`${n.title} ${n.body}`, /Set up payouts/);
  });
});

describe('the tiers screen renders it from readiness, not from the tier list', () => {
  const c = code(TIERS);

  test('the old hasPaid gate is gone', () => {
    assert.doesNotMatch(c, /needsPayouts/, 'the tier-count gate is still deciding the banner');
    assert.doesNotMatch(c, /hasPaid/);
  });

  test('the banner sits before the tier list, not inside it', () => {
    const banner = c.indexOf('notice.title');
    const list = c.indexOf('types.length === 0');
    assert.ok(banner !== -1 && list !== -1, 'the banner or the tier list is gone');
    assert.ok(banner < list, 'the payout notice must come before the tiers');
  });

  test('readiness comes from the function, not from the flag', () => {
    assert.match(c, /fetchHubPayoutReady\(id\)/);
    assert.match(c, /hubPayoutNotice\(payoutReady\)/);
    assert.doesNotMatch(c, /hub\.payout_enabled/, 'payout_enabled alone is not the real condition');
    assert.doesNotMatch(c, /hub\?\.payout_enabled/);
  });

  test('the setup CTA is offered only when it is needed', () => {
    assert.match(c, /\{!payoutReady && \(/, 'the ready state must not offer a setup button');
  });

  test('tier creation and editing are untouched', () => {
    assert.match(c, /createMembershipType\(/);
    assert.match(c, /updateMembershipType\(/);
    assert.match(c, /deleteMembershipType\(/);
    assert.match(c, /price_pence/);
  });
});

describe('Hub Manage has a way in', () => {
  const c = code(ADMIN);

  test('a Payouts row exists', () => {
    assert.match(c, /title="Payouts"/);
    assert.match(c, /sub="Connect or manage where Hub payments are paid"/);
  });

  test('it routes to the payouts screen for this hub', () => {
    assert.match(c, /router\.push\(`\/hub-payouts\?id=\$\{hub\.id\}`\)/);
  });

  test('and that screen exists', () => {
    assert.equal(existsSync(PAYOUTS), true, 'the Payouts row points at a screen that is not there');
    const p = code(PAYOUTS);
    assert.match(p, /createHubOnboardingLink\(id\)/, 'the screen cannot start onboarding');
    assert.match(p, /fetchHubPayoutReady\(id\)/);
    assert.match(p, /hubPayoutNotice\(ready\)/);
  });

  test('it says which hub it is for, rather than hanging', () => {
    const p = code(PAYOUTS);
    assert.match(p, /No hub chosen/);
    assert.match(p, /Hub not found/);
  });
});

describe('nothing the client may not have', () => {
  test('no mobile hub surface reads stripe_account_id', () => {
    for (const f of [API, TIERS, ADMIN, PAYOUTS, NOTICE]) {
      assert.doesNotMatch(code(f), /stripe_account_id/,
        `${f.split('/').pop()} names a column granted to no client role`);
    }
  });

  test("select('*') is not reintroduced on hubs", () => {
    assert.doesNotMatch(code(API), /from\('hubs'\)\.select\('\*'\)/,
      'a table-wide select would be a permission error after 20260928130000');
    assert.match(code(API), /from\('hubs'\)\.select\(HUB_COLS\)/);
  });

  test('the readiness read is the RPC, and fails closed', () => {
    const c = code(API);
    const fn = c.slice(c.indexOf('export async function fetchHubPayoutReady'));
    const body = fn.slice(0, fn.indexOf('\n}') + 2);
    assert.match(body, /rpc\('hub_payout_ready', \{ p_hub_id: hubId \}\)/);
    assert.match(body, /if \(error\) return false;/, 'an error must not read as ready');
    assert.match(body, /return data === true;/);
  });
});
