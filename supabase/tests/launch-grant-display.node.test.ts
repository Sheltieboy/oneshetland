/**
 * launch-grant-display.node.test.ts — a manually granted launch plan is described honestly to its owner.
 *
 * WHAT WAS WRONG
 *
 * A launch grant is Pro/Premium with an end date and no Stripe subscription. The owner's Plan card read that as a
 * paying customer — "Premium · £49.99/mo", "Renews 3 April" — and, for Pro, offered to sell them a paid boost on
 * top of a plan that is already free. Nothing renews and nothing is charged; the card now says so.
 *
 * Needs the sibling ../oneshetland-web checkout.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'oneshetland-web');
const have = existsSync(join(WEB, 'lib/launch-grant.ts'));
const opts = { skip: have ? false : 'sibling oneshetland-web checkout not found' };
const web = (rel: string) => readFileSync(join(WEB, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const mod = () => loadModule('../oneshetland-web/lib/launch-grant.ts');

const NOW = new Date('2026-11-10T12:00:00Z');
const row = (o: Record<string, unknown> = {}) => ({ tier: 'premium', expires_at: '2027-04-03T00:00:00Z', revoked_at: null, superseded_at: null, ...o });

describe('which grant counts as current access', opts, () => {
  test('an open grant that has not ended is current', () => {
    assert.deepEqual(mod().liveLaunchGrant([row()], false, NOW), { tier: 'premium', expiresAt: '2027-04-03T00:00:00Z' });
  });
  test('a genuine subscription always wins: the grant is history and is not described as access', () => {
    assert.equal(mod().liveLaunchGrant([row()], true, NOW), null);
  });
  test('expired, revoked and replaced grants give nothing', () => {
    const { liveLaunchGrant } = mod();
    assert.equal(liveLaunchGrant([row({ expires_at: '2026-11-10T11:59:59Z' })], false, NOW), null);
    assert.equal(liveLaunchGrant([row({ revoked_at: '2026-11-01T00:00:00Z' })], false, NOW), null);
    assert.equal(liveLaunchGrant([row({ superseded_at: '2026-11-01T00:00:00Z' })], false, NOW), null);
  });
  test('no rows, null and undefined are all "no grant" (an unreadable table must never invent one)', () => {
    const { liveLaunchGrant } = mod();
    assert.equal(liveLaunchGrant([], false, NOW), null);
    assert.equal(liveLaunchGrant(null, false, NOW), null);
    assert.equal(liveLaunchGrant(undefined, false, NOW), null);
  });
});

describe('what the owner is told', opts, () => {
  test('the badge names the plan and says launch partner — no price; the line gives the end date and says nothing renews', () => {
    const c = mod().launchGrantCopy({ tier: 'premium', expiresAt: '2027-04-03T00:00:00Z' }, 'Premium');
    assert.equal(c.badge, 'Premium · Launch partner');
    assert.match(c.line, /Plan access until 3 April 2027/);
    assert.match(c.line, /nothing renews and no payment is taken/);
    assert.doesNotMatch(`${c.badge} ${c.line}`, /£|\/mo|Renews/);
  });
});

describe('the Plan screen uses it', opts, () => {
  test('the billing page reads only OPEN grants for this business, as the owner (RLS)', () => {
    const s = web('app/business/[id]/manage/billing/page.tsx');
    assert.match(s, /\.from\("launch_plan_grants"\)/);
    assert.match(s, /\.eq\("business_id", business\.id\)/);
    assert.match(s, /\.is\("revoked_at", null\)/);
    assert.match(s, /\.is\("superseded_at", null\)/);
    assert.match(s, /createClient\(\)/);
    assert.match(s, /liveLaunchGrant\(.*business\.subscription_connected\)/);
    assert.match(s, /launchGrant=\{launchGrant\}/);
  });
  test('THE DEFECT: the card no longer shows a price chip or "Renews" for a grant, and no longer sells a boost over it', () => {
    const s = web('components/business/BillingManager.tsx');
    assert.match(s, /launchGrant \? launchGrantCopy\(launchGrant, TIER_LABELS\[tier\]\)\.badge : `\$\{TIER_LABELS\[tier\]\} · \$\{TIER_PRICE\[tier\]\}`/);
    assert.match(s, /\{launchGrant \? \(\s*<p[^>]*>\{launchGrantCopy\(launchGrant, TIER_LABELS\[tier\]\)\.line\}<\/p>\s*\) : b\.subscription_until && \(/);
    assert.match(s, /!b\.subscription_connected && !launchGrant && boostPreview\?\.boost_eligible/);
  });
  test('the ordinary subscriber path is untouched: price chip and Renews/Cancels/Boost line remain', () => {
    const s = web('components/business/BillingManager.tsx');
    assert.match(s, /isOnBoost\(b\) \? "Boost expires" : b\.subscription_cancel_at_period_end \? "Cancels on" : "Renews"/);
    assert.match(s, /TIER_LABELS\[tier\]\} · \$\{TIER_PRICE\[tier\]\}/);
  });
});

describe('the dead "Grant discount" action is gone from the admin claims screen', () => {
  const screen = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app/(admin)/business-claims.tsx'), 'utf8');
  test('THE DEFECT: no import, call, button or preset remains, so nothing implies a plan was changed', () => {
    assert.doesNotMatch(screen, /grantDiscount|offerDiscount|DISCOUNT_PRESETS|Grant discount|Discount granted/);
  });
  test('approve and reject are unchanged', () => {
    assert.match(screen, /await approveClaim\(c\.id\)/);
    assert.match(screen, /await rejectClaim\(c\.id\)/);
  });
});
