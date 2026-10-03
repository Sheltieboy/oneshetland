/**
 * notification-centre.node.test.ts
 *
 * The Notification Centre as a customer meets it, on web and in the app. The SQL rules (self-only reads, unread
 * counts, mark-read, quiet hours, preferences) are proved in notification-centre-sql.node.test.ts against a real
 * database; this file holds down the parts that live in app and web code:
 *
 *   • every kind of notification production actually holds opens a REAL screen, on both platforms
 *   • the new refund notices land on the ticket / Wallet screens
 *   • web and app agree on what the badge counts, on the preference switches, and on the destinations
 *   • a failed load or a failed save says so, instead of "Nothing yet" / "Saved ✓"
 *
 * The routing functions are the real ones, lifted out of the source and executed. Needs the sibling
 * ../oneshetland-web checkout.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(MOBILE, '..', 'oneshetland-web');
const haveWeb = existsSync(join(WEB, 'lib', 'notifications-inbox.ts'));
const opts = { skip: haveWeb ? false : 'sibling oneshetland-web checkout not found' };
const m = (rel: string) => readFileSync(join(MOBILE, rel), 'utf8');
const w = (rel: string) => readFileSync(join(WEB, rel), 'utf8');
const strip = (s: string) => stripTypeScriptTypes(s, { mode: 'strip' }).replace(/^export /gm, '');

/** Real payload shapes (category, data) taken from production's notification_log, ids anonymised. */
const PRODUCTION_SHAPES: Array<[string, Record<string, unknown>]> = [["bookings.reminder",{"booking_id":"00000000-0000-4000-8000-000000000000","screen":"local-my-bookings"}],["business.booking_cancelled",{"booking_id":"00000000-0000-4000-8000-000000000000","screen":"local-business-dashboard"}],["business.claim_approved",{"business_id":"00000000-0000-4000-8000-000000000000"}],["business.new_booking",{"booking_id":"00000000-0000-4000-8000-000000000000","screen":"local-business-dashboard"}],["business.order",{"business_id":"00000000-0000-4000-8000-000000000000","product_order_id":"00000000-0000-4000-8000-000000000000","screen":"business-orders"}],["business.payment_received",{"screen":"local-business-dashboard"}],["business.sale",{"screen":"local-business-dashboard"}],["business.subscription_ended",{"screen":"local-business-dashboard"}],["community.reaction",{"memory_id":"00000000-0000-4000-8000-000000000000","screen":"memory"}],["cruise.in_port_today",{"screen":"cruise-day","visit_date":"2026-09-16"}],["events.cancelled",{"event_id":"00000000-0000-4000-8000-000000000000","screen":"my-event-tickets"}],["events.reminder",{"event_id":"00000000-0000-4000-8000-000000000000","screen":"my-event-tickets"}],["events.tickets_confirmed",{"order_id":"00000000-0000-4000-8000-000000000000"}],["fetch.collected",{"request_id":"00000000-0000-4000-8000-000000000000"}],["fetch.delivered",{"request_id":"00000000-0000-4000-8000-000000000000"}],["fetch.driver_matched",{"request_id":"00000000-0000-4000-8000-000000000000"}],["fetch.new_request",{"request_id":"00000000-0000-4000-8000-000000000000"}],["games.streak",{"screen":"games"}],["hubs.donation_receipt",{"hub_id":"00000000-0000-4000-8000-000000000000"}],["hubs.donation_received",{"hub_id":"00000000-0000-4000-8000-000000000000"}],["hubs.member_joined",{"hub_id":"00000000-0000-4000-8000-000000000000","type":"hub_membership"}],["hubs.new_event",{"event_id":"00000000-0000-4000-8000-000000000000","hub_id":"00000000-0000-4000-8000-000000000000"}],["hubs.new_notice",{"hub_id":"00000000-0000-4000-8000-000000000000"}],["jobs.interview",{"job_id":"00000000-0000-4000-8000-000000000000","screen":"my-job-applications"}],["jobs.new_application",{"job_id":"00000000-0000-4000-8000-000000000000","screen":"job-applicants"}],["jobs.shortlisted",{"job_id":"00000000-0000-4000-8000-000000000000","screen":"my-job-applications"}],["jobs.withdrawn",{"job_id":"00000000-0000-4000-8000-000000000000","screen":"job-applicants"}],["loyalty.reward_ready",{"card_id":"00000000-0000-4000-8000-000000000000","screen":"local-my-cards"}],["loyalty.reward_ready",{"screen":"local-my-cards"}],["shifts.application_accepted",{"screen":"my-shift-applications"}],["shifts.application_rejected",{"screen":"my-shift-applications"}],["shifts.cancelled",{"screen":"my-shift-applications","shift_id":"00000000-0000-4000-8000-000000000000"}],["shifts.complete",{"screen":"my-shift-applications"}],["shifts.new_application",{"screen":"employer-applications"}],["shifts.new_match",{"screen":"shifts","shift_id":"00000000-0000-4000-8000-000000000000"}],["shifts.withdrawn",{"screen":"employer-applications","shift_id":"00000000-0000-4000-8000-000000000000"}],["shifts.worker_checked_in",{"screen":"my-posted-shifts"}],["shifts.worker_checked_out",{"screen":"my-posted-shifts"}],["wallet.charge_request",{"charge_request_id":"00000000-0000-4000-8000-000000000000","screen":"local-wallet"}],["wallet.gift_sent",{"gift_id":"00000000-0000-4000-8000-000000000000","screen":"local-my-gifts"}],["wallet.order_update",{"product_order_id":"00000000-0000-4000-8000-000000000000","screen":"my-orders"}],["wallet.pass_expiring",{"purchase_id":"00000000-0000-4000-8000-000000000000","screen":"local-my-passes"}],["wallet.payment",{"screen":"local-wallet"}],["wallet.purchase",{"screen":"local-my-passes"}],["wallet.topup",{"screen":"local-wallet"}]];
/** The shapes the refund notices added on 3 Oct will produce (not in production yet). */
const REFUND_SHAPES: Array<[string, Record<string, unknown>]> = [
  ['wallet.refunded', { screen: 'my-event-tickets', order_id: '00000000-0000-4000-8000-000000000000', refund_key: 'event_order:x' }],
  ['wallet.refunded', { screen: 'local-wallet', refund_key: 'wallet_txn:x' }],
];

const mobileRoute = (() => {
  const s = m('lib/notifications.ts');
  const a = s.indexOf('const SCREEN_ALIASES'); const b = s.indexOf('/**', s.indexOf('export function notificationRoute'));
  return new Function(strip(s.slice(a, b)) + ';return notificationRoute;')() as (d: Record<string, unknown> | null) => string | null;
})();
const mobileAliases = (() => {
  const s = m('lib/notifications.ts');
  const a = s.indexOf('const SCREEN_ALIASES'); const b = s.indexOf('};', a) + 2;
  return new Function(strip(s.slice(a, b)) + ';return SCREEN_ALIASES;')() as Record<string, string>;
})();
const webSrc = haveWeb ? w('lib/notifications-inbox.ts') : '';
const webSlice = () => { const a = webSrc.indexOf('const SCREEN_ALIASES'); const b = webSrc.indexOf('const MODULE_ACCENT'); return strip(webSrc.slice(a, b)); };
const webRoute = haveWeb ? (new Function(webSlice() + ';return webNotificationRoute;')() as (d: Record<string, unknown> | null) => string | null) : () => null;
const webAliases = haveWeb ? (new Function(webSlice() + ';return SCREEN_ALIASES;')() as Record<string, string>) : {};

function listRoutes(dir: string, isPage: (n: string) => boolean, prefix = '', acc = new Set<string>()): Set<string> {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) listRoutes(p, isPage, prefix + '/' + n, acc);
    else if (isPage(n)) acc.add(prefix || '/');
  }
  return acc;
}
const dynamicMatch = (pattern: string, path: string) =>
  pattern === path || (pattern.includes('[') && new RegExp('^' + pattern.replace(/\[[^\]]+\]/g, '[^/]+') + '$').test(path));

const mobileScreens = listRoutes(join(MOBILE, 'app'), (n) => n.endsWith('.tsx')).size
  ? [...listRoutes(join(MOBILE, 'app'), (n) => n.endsWith('.tsx'))].map((r) => r.replace(/\/\([^)]+\)/g, '').replace(/\.tsx$/, '').replace(/\/index$/, ''))
  : [];
const mobileFileRoutes = (() => {
  const out = new Set<string>();
  const walk = (d: string, p = '') => { for (const n of readdirSync(d)) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f, p + '/' + n); else if (n.endsWith('.tsx')) out.add((p + '/' + n).replace(/\/\([^)]+\)/g, '').replace(/\.tsx$/, '').replace(/\/index$/, '') || '/'); } };
  walk(join(MOBILE, 'app'));
  return out;
})();
const webPages = haveWeb ? listRoutes(join(WEB, 'app'), (n) => n === 'page.tsx' || n === 'route.ts') : new Set<string>();
const mobileExists = (r: string) => { const path = r.split('?')[0].replace(/\/\([^)]+\)/g, ''); return [...mobileFileRoutes].some((c) => dynamicMatch(c, path)) || /^\/\(tabs\)/.test(r); };
const webExists = (r: string) => [...webPages].some((c) => dynamicMatch(c, r.split('?')[0]));

describe('every notification production holds opens a real screen', opts, () => {
  const all = [...PRODUCTION_SHAPES, ...REFUND_SHAPES];
  test('the fixture is the real thing (a broad set of categories)', () => assert.ok(PRODUCTION_SHAPES.length >= 40));

  for (const [category, data] of all) {
    test(`${category} ${JSON.stringify(Object.keys(data))}`, () => {
      const mr = mobileRoute(data); const wr = webRoute(data);
      assert.ok(mr, 'the app has a destination');
      assert.ok(mobileExists(mr!), `app route ${mr} does not exist`);
      assert.ok(wr, 'the web has a destination');
      assert.ok(webExists(wr!), `web route ${wr} does not exist`);
    });
  }

  test('THE DEFECTS: ticket notices open My tickets (web), not My memberships; shop orders open Orders', () => {
    assert.equal(webRoute({ order_id: 'x' }), '/account/tickets');
    assert.equal(webRoute({ screen: 'my-event-tickets', event_id: 'x' }), '/account/tickets');
    assert.equal(webRoute({ product_order_id: 'x', screen: 'my-orders' }), '/account/orders');
    assert.equal(mobileRoute({ screen: 'employer-applications' }), '/my-posted-shifts', 'used to open a screen that does not exist');
  });

  test('refund notices: tickets → My tickets, Wallet refunds → the Wallet, on both platforms', () => {
    assert.equal(mobileRoute(REFUND_SHAPES[0][1]), '/my-event-tickets');
    assert.equal(webRoute(REFUND_SHAPES[0][1]), '/account/tickets');
    assert.equal(mobileRoute(REFUND_SHAPES[1][1]), '/local-wallet');
    assert.equal(webRoute(REFUND_SHAPES[1][1]), '/account/wallet');
  });

  test('a notification with no routing data is simply not tappable (no crash, no wrong page)', () => {
    assert.equal(mobileRoute(null), null); assert.equal(webRoute(null), null);
    assert.equal(mobileRoute({}), null); assert.equal(webRoute({ refund_key: 'only' }), null);
  });

  test('every screen alias the app routes also exists on the web (nothing silently app-only)', () => {
    const appOnly = new Set<string>([]);
    for (const k of Object.keys(mobileAliases)) {
      if (appOnly.has(k)) continue;
      assert.ok(webAliases[k], `web is missing alias "${k}"`);
    }
  });

  test('every screen name a backend sender uses has an alias on both platforms', () => {
    const FUNCS = join(MOBILE, 'supabase', 'functions');
    const names = new Set<string>();
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.ts') && !n.endsWith('.test.ts')) for (const x of readFileSync(p, 'utf8').matchAll(/screen:\s*'([a-z-]+)'/g)) names.add(x[1]); } };
    walk(FUNCS);
    // These are resolved from their ids rather than an alias (memory, boat) or need an id param (handled specially).
    const byId = new Set(['memory', 'boat', 'job-applicants', 'business-orders', 'cruise-day']);
    for (const n of names) {
      if (byId.has(n)) continue;
      assert.ok(mobileAliases[n], `app has no alias for "${n}"`);
      assert.ok(webAliases[n], `web has no alias for "${n}"`);
    }
  });
});

describe('badge, inbox and preferences agree across web and app', opts, () => {
  test('both inboxes show exactly sent / no_token / skipped_quiet', () => {
    const grab = (s: string) => [...(s.match(/VISIBLE_STATUSES\s*=\s*\[([^\]]+)\]/)![1]).matchAll(/["']([a-z_]+)["']/g)].map((x) => x[1]).sort();
    assert.deepEqual(grab(m('lib/notifications-inbox.ts')), ['no_token', 'sent', 'skipped_quiet']);
    assert.deepEqual(grab(w('lib/notifications-inbox.ts')), ['no_token', 'sent', 'skipped_quiet']);
  });

  test('the preference switches are the same fifteen on web, in the app, in the table and in should_notify', () => {
    const mod = (s: string) => [...s.matchAll(/prefKey:\s*'([a-z_]+_enabled)'/g)].map((x) => x[1]).sort();
    const appKeys = mod(m('lib/notification-prefs.ts'));
    const webKeys = [...w('components/account/NotificationPrefsForm.tsx').matchAll(/key:\s*"([a-z_]+_enabled)"/g)].map((x) => x[1]).sort();
    assert.equal(appKeys.length, 15);
    assert.deepEqual(webKeys, appKeys);
    const sql = readFileSync(join(MOBILE, 'supabase/migrations/20260627000000_notifications_spine.sql'), 'utf8');
    const caseModules = [...sql.slice(sql.indexOf('module_on := CASE')).matchAll(/WHEN '([a-z]+)'\s+THEN prefs\.([a-z_]+_enabled)/g)].map((x) => x[2]).sort();
    assert.deepEqual(caseModules, appKeys, 'should_notify covers every switch');
    const quiet = m('supabase/migrations/20261031010000_quiet_hours_stay_in_inbox.sql');
    const quietKeys = [...quiet.matchAll(/prefs\.([a-z_]+_enabled)/g)].map((x) => x[1]).filter((k) => k !== 'enabled').sort();
    assert.deepEqual(quietKeys, appKeys, 'the quiet-hours reclassifier knows every switch too');
  });

  test('quiet hours are offered on both platforms and applied in Shetland time', () => {
    assert.match(w('components/account/NotificationPrefsForm.tsx'), /Quiet hours/);
    assert.match(m('app/notification-preferences.tsx'), /Quiet hours/);
    assert.match(m('supabase/migrations/20260627000000_notifications_spine.sql'), /AT TIME ZONE 'Europe\/London'/);
  });
});

describe('rendering contracts — the same inbox on both platforms', opts, () => {
  const web = () => w('components/notifications/NotificationInbox.tsx');
  const app = () => m('app/notifications.tsx');

  test('each row shows title, body, relative time and an unread marker; tapping marks it read then opens the link', () => {
    for (const [name, s] of [['web', web()], ['app', app()]] as const) {
      assert.match(s, /item\.title/, name); assert.match(s, /item\.body/, name);
      assert.match(s, /relativeTime\(item\.created_at\)/, name);
      assert.match(s, /markNotificationsRead\(\[item\.id\]\)/, name);
      assert.match(s, /read_at/, name);
    }
    assert.match(web(), /webNotificationRoute\(item\.data\)/);
    assert.match(app(), /notificationRoute\(item\.data\)/);
  });

  test('mark-all-read, the empty state and the settings link exist', () => {
    assert.match(web(), /Mark all read/); assert.match(app(), /Mark all/);
    assert.match(web(), /Nothing yet/); assert.match(app(), /Nothing yet/);
    assert.match(w('app/notifications/page.tsx'), /href="\/account\/notifications"/);
  });

  test('timestamps: just now / minutes / hours / days / dated, identically on both', () => {
    const body = (s: string) => s.slice(s.indexOf('function relativeTime'), s.indexOf('\n}\n', s.indexOf('function relativeTime')));
    const norm = (s: string) => s.replace(/["']/g, '"').replace(/\s+/g, ' ');
    assert.equal(norm(body(web())), norm(body(app())));
  });

  test('THE DEFECT: a failed load says so instead of "Nothing yet" (web and app)', () => {
    assert.match(web(), /We couldn&rsquo;t load your notifications/);
    assert.match(web(), /catch\(\(\) => setFailed\(true\)\)/);
    assert.match(app(), /setFailed\(true\)/);
    assert.match(app(), /failed \? 'We couldn\\'t load your notifications'/);
  });

  test('THE DEFECT: a failed preference save is reported and reverted, never shown as "Saved ✓"', () => {
    const f = w('components/account/NotificationPrefsForm.tsx');
    assert.match(f, /const \{ error \} = await createClient\(\)\.from\("notification_preferences"\)\.upsert/);
    assert.match(f, /if \(error\) throw error/);
    assert.match(f, /setPrefs\(previous\)/);
    assert.match(f, /!saveError && savedAt > 0/);
    assert.match(m('app/notification-preferences.tsx'), /Could not save/);
  });

  test('both screens are for signed-in people only', () => {
    assert.match(w('app/notifications/page.tsx'), /redirect\("\/sign-in\?next=\/notifications"\)/);
    assert.match(w('app/account/notifications/page.tsx'), /redirect\("\/sign-in\?next=\/account\/notifications"\)/);
    assert.match(app(), /Sign in to see your notifications/);
  });

  test('the bell on both platforms shows the unread count from the same RPC', () => {
    assert.match(w('components/site/NotificationBell.tsx'), /fetchUnreadCount/);
    assert.match(m('components/NotificationBell.tsx'), /fetchUnreadCount/);
    assert.match(w('lib/notifications-inbox.ts'), /rpc\("unread_notification_count"\)/);
    assert.match(m('lib/notifications-inbox.ts'), /rpc\('unread_notification_count'\)/);
  });
});
