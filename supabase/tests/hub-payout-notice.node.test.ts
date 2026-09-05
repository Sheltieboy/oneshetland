/**
 * hub-payout-notice.node.test.ts — a warning that knows whether it applies.
 *
 * WHAT WAS WRONG
 *
 * The membership-tiers screen carried one sentence, hardcoded, shown to every
 * hub admin regardless of state:
 *
 *   "Paid tiers need a connected payout account. Set one up in the OneShetland
 *    app (Hub → payouts); free tiers work straight away."
 *
 * TiersManager took { hubId, tiers, accent } and no payout state whatsoever, so
 * it could not have been reacting to anything. A hub already taking money was
 * told to go and set up payouts. It also sent WEB users to the mobile app, when
 * the web app has that page and links to it from the management screen the
 * admin just came from.
 *
 * WHAT IS ASSERTED
 *   · a payout-ready hub is told so, and offered "Manage payouts"
 *   · a hub without payouts gets the setup CTA, and is told free tiers still work
 *   · the mobile-app instruction is gone from the web component
 *   · the CTA points at the existing web route, carrying its return target
 *   · payout state is passed in from the server, never inferred in the browser
 *   · no Stripe account id crosses to the client
 *   · payment routing and the server's own gate are untouched
 *
 * SAFETY
 * Reads source from the web repository and executes the real helper. No
 * database, no network, no writes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const NOTICE = join(WEB, 'lib/hub-payout-notice.ts');
const MANAGER = join(WEB, 'components/hubs/admin/TiersManager.tsx');
const TIERS_PAGE = join(WEB, 'app/hubs/[id]/manage/tiers/page.tsx');
const PAYOUTS_PAGE = join(WEB, 'app/hubs/[id]/manage/payouts/page.tsx');
const SERVER = join(WEB, 'lib/hubs-server.ts');
const INTENT = join(REPO_ROOT, 'supabase/functions/create-hub-membership-intent/index.ts');

const src = (p: string) => readFileSync(p, 'utf8');
const code = (p: string) => src(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** Run the real module rather than reading it for reassuring words. */
function load() {
  const js = ts.transpileModule(src(NOTICE), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports_: Record<string, unknown> = {};
  new Function('exports', js)(exports_);
  return exports_ as {
    hubPayoutNotice: (ready: boolean) => { title: string; body: string; cta: string };
    hubPayoutHref: (idOrSlug: string, next?: 'tiers') => string;
  };
}
const M = load();

describe('a hub that can be paid is told so', () => {
  const n = M.hubPayoutNotice(true);

  test('the heading confirms it rather than warning', () => {
    assert.equal(n.title, 'Payouts ready ✓');
  });

  test('it says where the money goes', () => {
    assert.match(n.body, /Membership payments will be paid to this Hub's connected payout account\./);
  });

  test('the action manages, it does not set up again', () => {
    assert.equal(n.cta, 'Manage payouts');
  });

  test('it does not tell a paid-up hub to go and connect an account', () => {
    assert.doesNotMatch(`${n.title} ${n.body} ${n.cta}`, /set up payouts/i);
  });
});

describe('a hub that cannot be paid is told what to do', () => {
  const n = M.hubPayoutNotice(false);

  test('the heading is the instruction', () => {
    assert.equal(n.title, 'Set up payouts to offer paid memberships');
  });

  test('free tiers are still offered, so the screen is not a dead stop', () => {
    assert.match(n.body, /Free tiers work straight away/);
  });

  test('the action is the setup', () => {
    assert.equal(n.cta, 'Set up payouts');
  });

  test('the two states are genuinely different copy', () => {
    const ready = M.hubPayoutNotice(true);
    assert.notEqual(n.title, ready.title);
    assert.notEqual(n.cta, ready.cta);
  });
});

describe('the CTA goes to the web route that exists', () => {
  test('it is the hub payouts page', () => {
    assert.equal(M.hubPayoutHref('demo-hub'), '/hubs/demo-hub/manage/payouts');
  });

  test('and carries the return target when asked', () => {
    assert.equal(M.hubPayoutHref('demo-hub', 'tiers'), '/hubs/demo-hub/manage/payouts?next=tiers');
  });

  test('that route really is present in the web app', () => {
    assert.ok(src(PAYOUTS_PAGE).length > 0, 'the hub payouts page is gone');
    assert.match(code(PAYOUTS_PAGE), /PayoutButton/, 'the payouts page no longer offers onboarding');
  });

  test('and it honours the return target instead of dead-ending', () => {
    const p = code(PAYOUTS_PAGE);
    assert.match(p, /next === ["']tiers["']/);
    assert.match(p, /manage\$\{backToTiers \? ["']\/tiers["'] : ["']["']\}/);
  });
});

describe('no web screen sends a web user to the mobile app', () => {
  test('the hardcoded instruction is gone', () => {
    const c = code(MANAGER);
    assert.doesNotMatch(c, /OneShetland app/, 'the mobile-app instruction is still there');
    assert.doesNotMatch(c, /Paid tiers need a connected payout account/);
    assert.doesNotMatch(c, /Hub → payouts/);
  });

  test('the notice is rendered from the helper, not written inline', () => {
    const c = code(MANAGER);
    assert.match(c, /hubPayoutNotice\(payoutReady\)/);
    assert.match(c, /\{notice\.title\}/);
    assert.match(c, /\{notice\.body\}/);
    assert.match(c, /\{notice\.cta\}/);
  });
});

describe('the state comes from the server, and only the state', () => {
  test('TiersManager is given payoutReady rather than guessing', () => {
    const c = code(MANAGER);
    assert.match(c, /payoutReady: boolean;/);
    assert.match(c, /payoutHref: string;/);
    assert.doesNotMatch(c, /stripe_account_id/, 'a Stripe account id must never reach the client');
  });

  test('the tiers page resolves it server-side and passes it down', () => {
    const p = code(TIERS_PAGE);
    assert.match(p, /const payoutReady = await hubPayoutReady\(hub\.id\)/);
    assert.match(p, /payoutReady=\{payoutReady\}/);
    assert.match(p, /payoutHref=\{hubPayoutHref\(hub\.slug \|\| hub\.id, ["']tiers["']\)\}/);
  });

  test('the server read returns a boolean, not an account id', () => {
    const s = code(SERVER);
    const fn = s.slice(s.indexOf('export async function hubPayoutReady'));
    const body = fn.slice(0, fn.indexOf('\n}') + 2);
    assert.match(body, /Promise<boolean>/);
    assert.match(body, /return !!\(data\?\.payout_enabled && data\?\.stripe_account_id\)/);
  });

  test('and it asks the same question the server gate asks', () => {
    // create-hub-membership-intent: hub's own account AND payouts enabled.
    assert.match(code(INTENT), /hubHasAccount = !!\(hub\.stripe_account_id && hub\.payout_enabled\)/);
  });

  test('the hub payout columns are not added to the public column list', () => {
    const data = code(join(WEB, 'lib/hubs-data.ts'));
    const cols = data.slice(data.indexOf('const HUB_COLS'), data.indexOf('const HUB_COLS') + 400);
    assert.doesNotMatch(cols, /stripe_account_id|payout_enabled/,
      'a Stripe account id would be served on every public hub page');
  });
});

describe('nothing about the money moved', () => {
  test('the membership intent still requires the hub’s own account', () => {
    const c = code(INTENT);
    assert.match(c, /if \(!isDemoHub && !hubHasAccount\)/);
    assert.match(c, /transfer_data\[destination\]/);
  });

  test('no central-account inheritance was smuggled in', () => {
    const c = code(INTENT);
    assert.doesNotMatch(c, /driver_profiles/, 'the intent must not have learned to inherit');
    const profileReads = c.match(/from\(['"]profiles['"]\)/g) ?? [];
    assert.equal(profileReads.length, 1, 'the only profiles read is the buyer’s saved card');
  });

  test('tier creation is unchanged', () => {
    const c = code(MANAGER);
    assert.match(c, /createMembershipType\(hubId, \{/);
    assert.match(c, /price_pence: Math\.round\(\(parseFloat\(price\) \|\| 0\) \* 100\)/);
    assert.match(c, /deleteMembershipType\(t\.id\)/);
  });
});
