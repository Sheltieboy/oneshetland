/**
 * launch-partner-admin-ui.node.test.ts — the web admin control for launch-partner access.
 *
 * Darren operates grants from /admin/claims → "Launch partner access", with no SQL. The screen must (1) only
 * collect inputs and call the three secured database functions, never decide entitlement itself; (2) identify the
 * business and its current plan; (3) refuse to offer a grant on a business that pays; (4) require expiry and
 * reason; (5) ask before acting; (6) never imply money moved; (7) be admin-only; and (8) the old discount
 * action must not exist anywhere on the web.
 *
 * Needs the sibling ../oneshetland-web checkout.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'oneshetland-web');
const have = existsSync(join(WEB, 'lib/launch-grant.ts'));
const opts = { skip: have ? false : 'sibling oneshetland-web checkout not found' };
const code = (rel: string) => readFileSync(join(WEB, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const mod = () => loadModule('../oneshetland-web/lib/launch-grant.ts');

const row = (o: Record<string, unknown> = {}) => ({
  business_id: 'b1', name: 'Voe Gift Shop', category: 'retail', address: 'Voe', is_active: true, is_claimed: true,
  tier: 'free', plan_until: null, plan_live: false, has_subscription: false, grant_id: null, grant_tier: null, grant_expires_at: null, ...o,
});

describe('what the screen says about the current plan', opts, () => {
  test('a Free business can be granted', () => {
    const p = mod().describePlan(row());
    assert.equal(p.canGrant, true); assert.equal(p.kind, 'free'); assert.match(p.text, /Free plan/);
  });
  test('REFUSES a business with a real Stripe subscription — no form is offered', () => {
    const p = mod().describePlan(row({ has_subscription: true, tier: 'premium', plan_live: true, plan_until: '2027-01-01T00:00:00Z' }));
    assert.equal(p.canGrant, false); assert.equal(p.kind, 'subscription'); assert.match(p.text, /real Stripe subscription/);
  });
  test('an active launch grant is shown with the agreed wording, and can be changed', () => {
    const p = mod().describePlan(row({ tier: 'pro', plan_live: true, plan_until: '2027-04-03T00:00:00Z', grant_id: 'g', grant_tier: 'pro', grant_expires_at: '2027-04-03T00:00:00Z' }));
    assert.equal(p.kind, 'grant'); assert.equal(p.canGrant, true);
    assert.match(p.text, /Launch partner access: Pro\. Included free until 3 April 2027\. No Stripe subscription or payment will be created\./);
  });
  test('a live plan that is not ours (a paid boost) is not offered for overwrite', () => {
    const p = mod().describePlan(row({ tier: 'pro', plan_live: true, plan_until: '2026-12-01T00:00:00Z' }));
    assert.equal(p.canGrant, false); assert.equal(p.kind, 'other-plan');
  });
  test('an ended plan reads as Free now, and can be granted', () => {
    const p = mod().describePlan(row({ tier: 'pro', plan_live: false, plan_until: '2026-01-05T00:00:00Z' }));
    assert.equal(p.canGrant, true); assert.match(p.text, /Free now\. A Pro plan ended on 5 January 2026/);
  });
});

describe('expiry and messages', opts, () => {
  test('a picked date becomes the end of that local day; junk becomes null', () => {
    const { expiryFromDate } = mod();
    const iso = expiryFromDate('2027-04-03');
    const d = new Date(iso as string);
    assert.deepEqual([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()], [2027, 4, 3, 23, 59]);
    for (const bad of ['', '3/4/2027', '2027-13-45', 'tomorrow']) assert.equal(expiryFromDate(bad), null, bad);
  });
  test('the picker window is tomorrow .. just under 24 months, always inside what the database accepts', () => {
    const { expiryBounds, expiryFromDate } = mod();
    for (const now of [new Date(2026, 9, 3, 0, 5), new Date(2026, 9, 3, 23, 55), new Date(2027, 0, 31, 12, 0)]) {
      const { min, max } = expiryBounds(now);
      const lo = new Date(expiryFromDate(min) as string).getTime(), hi = new Date(expiryFromDate(max) as string).getTime();
      assert.ok(lo >= now.getTime() + 24 * 3600e3, `min ${min} must be at least a day away from ${now.toISOString()}`);
      const cap = new Date(now); cap.setMonth(cap.getMonth() + 24);
      assert.ok(hi <= cap.getTime(), `max ${max} must be inside 24 months`);
    }
  });
  test('database sentences are shown plainly, without transport noise', () => {
    const { dbMessage } = mod();
    assert.equal(dbMessage({ message: 'ERROR:  Voe Gift Shop already has a genuine subscription (SQLSTATE 55000)' }), 'Voe Gift Shop already has a genuine subscription');
    assert.equal(dbMessage(new Error('plain')), 'plain');
    assert.equal(dbMessage(null), 'Something went wrong.');
  });
});

describe('the control calls the secured functions and nothing else', opts, () => {
  const c = () => code('components/admin/LaunchPartnerAccess.tsx');
  test('only the four admin functions are called; no table is written and no entitlement is computed in the browser', () => {
    const calls = [...c().matchAll(/\.rpc\(\s*"(\w+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual([...new Set(calls)], ['admin_grant_launch_plan', 'admin_launch_business_lookup', 'admin_revoke_launch_plan']);
    assert.doesNotMatch(c(), /\.from\(|\.insert\(|\.update\(|\.upsert\(|subscription_tier|subscription_until|stripe_/);
  });
  test('grant requires an expiry and a reason before the button works, and asks first', () => {
    const s = c();
    assert.match(s, /grantReady = [^;]*expiryFromDate\(date\)[^;]*reason\.trim\(\)\.length >= GRANT_REASON_MIN/);
    assert.match(s, /const ok = await confirm\(\{\s*title: "Grant launch partner access\?"[\s\S]*?\}\);\s*if \(!ok\) return;[\s\S]*?admin_grant_launch_plan/);
    assert.match(s, /const ok = await confirm\(\{\s*title: "Remove launch partner access\?"[\s\S]*?danger: true,?\s*\}\);\s*if \(!ok\) return;[\s\S]*?admin_revoke_launch_plan/);
  });
  test('it never implies money moved: the wording says included free and no payment, and a failure says nothing changed', () => {
    const s = c();
    assert.match(s, /No Stripe subscription or payment will be created/);
    assert.match(s, /No payment was taken and no subscription was created/);
    assert.match(s, /Nothing was changed/);
    assert.doesNotMatch(s, /£|charged|\bbilled\b|invoice|renews/i);
  });
  test('the form is not rendered when the business pays or holds a plan that is not ours', () => {
    assert.match(c(), /\{plan\.canGrant && \(/);
  });
  test('the business is identified (name, category, address, id) before anything can be granted', () => {
    const s = c();
    assert.match(s, /selected\.name/); assert.match(s, /selected\.business_id/); assert.match(s, /selected\.address/);
  });
});

describe('where it lives and who can reach it', opts, () => {
  test('it is a tab on /admin/claims, inside the admin layout that requires an admin', () => {
    const page = code('app/admin/claims/page.tsx');
    assert.match(page, /\["launch", "Launch partner access"\]/);
    assert.match(page, /<LaunchPartnerAccess grants=\{grants\} initial=\{picked\}/);
    assert.match(code('app/admin/layout.tsx'), /await requireAdmin\(\)/);
  });
  test('an approved claim links straight to its business on the launch tab', () => {
    assert.match(code('components/admin/ClaimsManager.tsx'), /\/admin\/claims\?status=launch&business=\$\{r\.business\.id\}/);
  });
});

describe('the legacy discount action is gone from every web surface', opts, () => {
  const walk = (d: string, out: string[] = []): string[] => {
    for (const n of readdirSync(d)) {
      if (['node_modules', '.next', '.git'].includes(n)) continue;
      const p = join(d, n); const st = statSync(p);
      if (st.isDirectory()) walk(p, out); else if (/\.(tsx?|jsx?)$/.test(n)) out.push(p);
    }
    return out;
  };
  test('no web file offers, labels or writes a discount grant', () => {
    const hits = ['app', 'components', 'lib'].flatMap((d) => walk(join(WEB, d)))
      .filter((f) => /Grant discount|grantDiscount|business_discount_grants/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(hits, []);
  });
});
