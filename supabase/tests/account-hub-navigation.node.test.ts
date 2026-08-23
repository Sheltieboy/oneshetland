/**
 * account-hub-navigation.node.test.ts — the app's account centre.
 *
 * WHAT WAS WRONG
 *
 * The mobile account hub — app/(tabs)/me.tsx, reached from the Home avatar —
 * covered Work, businesses, payments, the Fetch lane, preferences and account
 * settings, and nothing at all about what the user had BOUGHT. Beside the web
 * My Account it read as a settings screen rather than an account centre.
 *
 * The screens were not missing. /my-orders, /my-event-tickets,
 * /local-my-passes, /local-my-bookings, /local-my-gifts, /local-wallet,
 * /local-my-cards, /hub-my-memberships and /games/stats all already existed and
 * all already worked — several were reachable only from a checkout success
 * screen, a push deep link, or another hub two levels down. Paygate 2 testing
 * hit the sharp end of it: a buyer who had just paid £185 had nowhere to go and
 * look at the purchase.
 *
 * WHAT IS ASSERTED
 *   · the transactional destinations are present, and sit ABOVE the settings
 *     part of the screen rather than under it
 *   · every in-app route the hub navigates to resolves to a real route file —
 *     the property that stops this screen growing a dead link later
 *   · the destinations that were already there survived the regrouping
 *   · rows keep their accessible labels, and read without their icons
 *   · business and admin entries stay conditional, and the customer entries
 *     are not hidden behind those conditions
 *
 * The app has no render harness, so these are structural checks of the same
 * kind this suite already makes against app source.
 *
 * SAFETY
 * Source inspection only. No network, no database, no payment.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(APP_ROOT, p), 'utf8');

const hub = read('app/(tabs)/me.tsx');

/** Every in-app route the hub can navigate to. */
function routesIn(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/router\.(?:push|replace)\(\s*'([^']+)'/g)) out.add(m[1]);
  for (const m of src.matchAll(/pathname:\s*'([^']+)'/g)) out.add(m[1]);
  return [...out];
}

/** Expo Router resolves `/foo` from app/foo.tsx or app/foo/index.tsx. */
function routeExists(route: string): boolean {
  const rel = route.replace(/^\//, '');
  return existsSync(join(APP_ROOT, 'app', `${rel}.tsx`))
      || existsSync(join(APP_ROOT, 'app', rel, 'index.tsx'));
}

// ── 1. No dead links, ever ─────────────────────────────────────────────────

describe('every account destination is a real screen', () => {
  test('the hub navigates somewhere real in every case', () => {
    const routes = routesIn(hub);
    assert.ok(routes.length >= 20, `expected a populated hub, found ${routes.length} routes`);
    const dead = routes.filter((r) => !routeExists(r));
    assert.deepEqual(dead, [], `dead account links: ${dead.join(', ')}`);
  });

  test('the same holds for the /account settings screen it hands off to', () => {
    const dead = routesIn(read('app/account.tsx')).filter((r) => !routeExists(r));
    assert.deepEqual(dead, [], `dead links on /account: ${dead.join(', ')}`);
  });
});

// ── 2. What a buyer came looking for ───────────────────────────────────────

describe('the things you have bought are on the account hub', () => {
  const TRANSACTIONAL: [string, string][] = [
    ['Shop orders', '/my-orders'],
    ['Event tickets', '/my-event-tickets'],
    ['Passes & vouchers', '/local-my-passes'],
    ['Bookings', '/local-my-bookings'],
    ['Gifts received', '/local-my-gifts'],
  ];

  for (const [label, route] of TRANSACTIONAL) {
    test(`${label} is linked, and points at ${route}`, () => {
      assert.match(hub, new RegExp(`label="${label.replace(/&/g, '&')}"`));
      assert.ok(hub.includes(`router.push('${route}')`), `${label} does not push ${route}`);
    });
  }

  test('they are grouped, not scattered through the settings', () => {
    assert.match(hub, /<SectionCard title="Your purchases"/);
  });

  test('and they come before the settings half of the screen', () => {
    const purchases = hub.indexOf('title="Your purchases"');
    for (const later of ['title="Preferences"', 'title="Account"']) {
      assert.ok(purchases > -1 && purchases < hub.indexOf(later), `purchases sit below ${later}`);
    }
  });

  test('money you hold is reachable too', () => {
    assert.match(hub, /<SectionCard title="Wallet & loyalty"/);
    assert.ok(hub.includes("router.push('/local-wallet')"));
    assert.ok(hub.includes("router.push('/local-my-cards')"));
  });
});

// ── 3. Nothing that was there went missing ─────────────────────────────────

describe('the regrouping did not drop anything', () => {
  const PRESERVED = [
    '/my-work', '/payment-setup', '/(driver)/connect-bank', '/referrals',
    '/(customer)/saved-addresses', '/(customer)/previous-requests',
    '/notifications', '/notification-preferences', '/blocked-users',
    '/edit-profile', '/security', '/account',
  ];

  for (const route of PRESERVED) {
    test(`${route} is still reachable from the hub`, () => {
      assert.ok(routesIn(hub).includes(route), `${route} disappeared from the account hub`);
    });
  }

  test('sign out and account deletion survive', () => {
    assert.match(hub, /handleSignOut/);
    assert.match(hub, /label="Delete account"/);
    // Deletion still hands off to /account rather than duplicating the flow.
    assert.match(hub, /label="Delete account"[\s\S]{0,400}?router\.push\('\/account'\)/);
  });

  test('the shop-orders row added to /account is still there', () => {
    assert.match(read('app/account.tsx'), /label="Your shop orders"/);
  });
});

// ── 4. Conditional content stays conditional ───────────────────────────────

describe('business and admin entries are earned, not universal', () => {
  test('the businesses section only renders when the user has one', () => {
    assert.match(hub, /\{myBusinesses\.length > 0 && \(\s*<SectionCard title="Your businesses"/);
  });

  test('admin is gated on the role', () => {
    assert.match(hub, /\{profile\?\.role === 'admin' && \(\s*<SectionCard title="Admin"/);
  });

  test('payout onboarding is only for people who receive money', () => {
    assert.match(hub, /const isSeller = hasAppliedToDrive \|\| myBusinesses\.length > 0;/);
  });

  test('the purchase rows are NOT gated on any of that', () => {
    const section = hub.match(/<SectionCard title="Your purchases"[\s\S]*?<\/SectionCard>/)?.[0] ?? '';
    assert.ok(section.length > 0, 'purchases section not found');
    for (const gate of ['myBusinesses', 'isSeller', "role === 'admin'", 'isDriver']) {
      assert.ok(!section.includes(gate), `purchases are gated on ${gate}`);
    }
  });
});

// ── 5. Readable without the icons ──────────────────────────────────────────

describe('the rows are usable by touch and by VoiceOver', () => {
  test('MenuRow builds its accessible label from the text, not the icon', () => {
    // Slice to the next top-level declaration: the component's own body has
    // several `\n}` of its own (the destructured props type, for one).
    const start = hub.indexOf('function MenuRow');
    const row = start > -1 ? hub.slice(start, hub.indexOf('export default', start)) : '';
    assert.ok(row.length > 0, 'MenuRow not found');
    assert.match(row, /accessibilityRole="button"/);
    assert.match(row, /accessibilityLabel=\{\[label, sublabel, badge\]\.filter\(Boolean\)\.join\('\. '\)\}/);
  });

  test('every new row carries a text label and a sublabel', () => {
    const section = hub.match(/<SectionCard title="Your purchases"[\s\S]*?<\/SectionCard>/)?.[0] ?? '';
    // \b keeps this off `sublabel=`, whose tail is also "label".
    const labels = [...section.matchAll(/\blabel="([^"]+)"/g)].map((m) => m[1]);
    const subs = [...section.matchAll(/sublabel="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(labels.length, 5);
    assert.equal(subs.length, 5, 'a purchase row is missing its sublabel');
    for (const l of labels) assert.ok(l.trim().length > 2, `weak label: ${l}`);
  });

  test('icons are decoration — no row is identified by icon alone', () => {
    // A literal label="…" or a bound one (label={biz.name}) both count; an
    // icon with no label at all does not.
    for (const m of hub.matchAll(/<MenuRow\b[\s\S]*?\/>/g)) {
      assert.match(m[0], /\blabel=[{"]/, `a MenuRow has no text label: ${m[0].slice(0, 80)}`);
    }
  });
});
