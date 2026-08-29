/**
 * stripe-load-boundary.node.test.ts — Stripe.js loads where payments happen.
 *
 * `@stripe/stripe-js` inserts its script tag "as a side effect immediately upon
 * importing this module" (Stripe's own README), so importing it anywhere puts
 * js.stripe.com — and its __stripe_mid / __stripe_sid cookies — on the page.
 *
 * The currency formatter `gbp` lived in lib/stripe.ts. ChargeApprovalListener
 * is mounted in the root layout on EVERY page and imported it for that one
 * function, so Stripe.js was loading on the homepage, the Directory and What's
 * On. Measured on the live site before this change: both Stripe cookies present
 * on a fresh anonymous visit to all three, with no payment anywhere near.
 *
 * The formatter moved to lib/currency.ts, which has no imports at all. Stripe
 * still loads on real payment surfaces, and its fraud signals are untouched —
 * advancedFraudSignals was never disabled and getStripe is unchanged.
 *
 * These tests walk the actual import graph rather than trusting a grep of one
 * file, so re-introducing the dependency two hops away still fails.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(WEB, p), 'utf8');

/** Resolve a `@/...` import to a real file on disk. */
function resolveAlias(spec: string): string | null {
  if (!spec.startsWith('@/')) return null;
  const base = join(WEB, spec.slice(2));
  for (const c of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** Every `@/...` and bare-package import in a file. */
function importsOf(absPath: string): string[] {
  const src = readFileSync(absPath, 'utf8');
  return [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
}

/**
 * Walk the import graph from a file and report whether Stripe is reachable.
 * Returns the chain that reaches it, or null.
 */
function stripeReachableFrom(entry: string): string[] | null {
  const start = resolve(WEB, entry);
  const seen = new Set<string>();
  const stack: { file: string; chain: string[] }[] = [{ file: start, chain: [entry] }];
  while (stack.length) {
    const { file, chain } = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) {
      if (spec.startsWith('@stripe/stripe-js') || spec.startsWith('@stripe/react-stripe-js')) {
        return [...chain, spec];
      }
      const next = resolveAlias(spec);
      if (next) stack.push({ file: next, chain: [...chain, spec] });
    }
  }
  return null;
}

/* ── 1. The global component that caused it ─────────────────────────────── */

describe('nothing global reaches Stripe.js any more', () => {
  test('ChargeApprovalListener does not import lib/stripe or @stripe/*', () => {
    const src = read('components/wallet/ChargeApprovalListener.tsx');
    assert.ok(!/@\/lib\/stripe["']/.test(src), 'it must not import the Stripe module');
    assert.ok(!/@stripe\//.test(src), 'nor Stripe directly');
    assert.match(src, /import \{ gbp \} from "@\/lib\/currency";/);
  });

  test('and Stripe is unreachable through anything it DOES import', () => {
    const chain = stripeReachableFrom('components/wallet/ChargeApprovalListener.tsx');
    assert.equal(chain, null,
      `Stripe.js is still reachable from the global listener: ${chain?.join(' → ')}`);
  });

  test('no component mounted in the root layout reaches Stripe.js', () => {
    const layout = read('app/layout.tsx');
    const globals = [...layout.matchAll(/from\s+["'](@\/components\/[^"']+)["']/g)].map((m) => m[1]);
    assert.ok(globals.length >= 5, 'the layout imports were found');
    for (const g of globals) {
      const file = resolveAlias(g);
      if (!file) continue;
      const chain = stripeReachableFrom(file.slice(WEB.length + 1));
      assert.equal(chain, null, `${g} pulls Stripe.js onto every page: ${chain?.join(' → ')}`);
    }
  });
});

/* ── 2. The utility it moved to ─────────────────────────────────────────── */

describe('the currency formatter depends on nothing', () => {
  test('lib/currency.ts has no imports at all', () => {
    const src = read('lib/currency.ts');
    assert.ok(!/^\s*import\s/m.test(src), 'a formatter must not decide what the browser loads');
    assert.match(src, /export function gbp\(pence: number\): string/);
  });

  test('it formats the way the old one did', () => {
    // Evaluated from the real source, with only the type annotations stripped
    // so plain JS can run it — the body under test is the shipped one.
    const src = read('lib/currency.ts')
      .replace(/export /g, '')
      .replace(/\(pence: number\): string/, '(pence)');
    const gbp = new Function(`${src}; return gbp;`)() as (p: number) => string;
    assert.equal(gbp(2000), '£20');
    assert.equal(gbp(1550), '£15.50');
    assert.equal(gbp(0), '£0');
    assert.equal(gbp(95), '£0.95');
  });

  test('lib/stripe.ts no longer exports a formatter to tempt anyone', () => {
    const src = read('lib/stripe.ts');
    assert.ok(!/export function gbp/.test(src));
    assert.ok(!/export \{[^}]*gbp/.test(src), 'not even re-exported — that would keep the dependency alive');
    assert.match(src, /export function getStripe/);
  });
});

/* ── 3. Who still imports Stripe, and why ───────────────────────────────── */

describe('Stripe still loads exactly where a payment happens', () => {
  const importers = () => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(WEB, dir))) {
        const rel = `${dir}/${e}`;
        if (statSync(join(WEB, rel)).isDirectory()) { walk(rel); continue; }
        if (!/\.tsx?$/.test(e)) continue;
        if (/from\s+["']@\/lib\/stripe["']/.test(read(rel))) out.push(rel);
      }
    };
    for (const d of ['app', 'components', 'lib']) walk(d);
    return out.sort();
  };

  test('only the two payment components import the Stripe loader', () => {
    assert.deepEqual(importers(), [
      'components/payments/CardSetup.tsx',
      'components/payments/PaymentCheckout.tsx',
    ]);
  });

  test('and they still use it', () => {
    for (const f of ['components/payments/CardSetup.tsx', 'components/payments/PaymentCheckout.tsx']) {
      assert.match(read(f), /import \{ getStripe \} from "@\/lib\/stripe";/, f);
      assert.match(read(f), /getStripe\(\)/, `${f} must still load Stripe`);
      assert.match(read(f), /@stripe\/react-stripe-js/, `${f} must still mount Elements`);
    }
  });

  test('the checkout still takes its formatter from the safe module', () => {
    assert.match(read('components/payments/PaymentCheckout.tsx'), /import \{ gbp \} from "@\/lib\/currency";/);
  });

  test('the SCA helper is unchanged and reached only from the basket', () => {
    assert.match(read('lib/stripe-sca.ts'), /loadStripe/);
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(WEB, dir))) {
        const rel = `${dir}/${e}`;
        if (statSync(join(WEB, rel)).isDirectory()) { walk(rel); continue; }
        if (/\.tsx?$/.test(e) && /@\/lib\/stripe-sca/.test(read(rel))) users.push(rel);
      }
    };
    for (const d of ['app', 'components', 'lib']) walk(d);
    assert.deepEqual(users, ['app/basket/page.tsx'], 'only a payment surface may reach it');
  });

  test('fraud signals were not switched off to achieve any of this', () => {
    for (const f of ['lib/stripe.ts', 'lib/stripe-sca.ts']) {
      assert.ok(!/advancedFraudSignals/.test(read(f)),
        `${f} must not disable Stripe's fraud detection`);
      assert.ok(!/stripe-js\/pure/.test(read(f)),
        `${f} keeps the ordinary loader; the fix was the import graph, not the loader`);
    }
    assert.match(read('lib/stripe.ts'), /loadStripe\(process\.env\.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!\)/,
      'the publishable key and loader call are untouched');
  });
});

/* ── 4. Analytics consent is none of this change's business ─────────────── */

describe('the consent-gated analytics is untouched', () => {
  test('track() still refuses before consent, before any identifier exists', () => {
    const src = read('lib/analytics.ts');
    const fn = src.slice(src.indexOf('export function track('));
    const gate = fn.indexOf('getAnalyticsConsent()');
    assert.ok(gate > 0 && gate < fn.indexOf('anonId()'),
      'consent must still be checked before an anon id is created');
    assert.match(src, /localStorage\.getItem\(CONSENT_KEY\) === "true"/);
  });

  test('the banner and provider are unchanged by this task', () => {
    assert.match(read('components/analytics/ConsentBanner.tsx'), /os_analytics_consent/);
    assert.ok(!/currency|stripe/i.test(read('components/analytics/AnalyticsProvider.tsx')));
  });
});
