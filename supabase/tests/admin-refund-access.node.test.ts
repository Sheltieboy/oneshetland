/**
 * admin-refund-access.node.test.ts — the refund control has to be reachable.
 *
 * WHAT WENT WRONG
 *
 * The membership refund screen was built in the native app and reported as
 * "Admin → Payments → Memberships". It was not reachable by the person who
 * needed it, for two independent reasons, and the report claimed a path
 * without checking either:
 *
 *   1. Native code reaches installed devices by EAS Update (u.expo.dev,
 *      channels preview/production). Pushing to git does not publish one, and
 *      none was published — so the installed app cannot contain the screen.
 *   2. The Admin entry renders only for profiles.role = 'admin'. Exactly one
 *      account holds that, and it is not the account the work is done from.
 *
 * The native screen is correctly written and correctly linked in source
 * (Me → Admin dashboard → Platform → Payments), so it stays. Financial
 * administration now also lives on the web, where the administrator already is
 * and where a deploy actually reaches them.
 *
 * The refund itself is untouched: refund-payment remains the only thing that
 * moves money, and the web page calls it rather than reimplementing it.
 *
 * SAFETY
 * Source-level plus read-only production assertions. No refund issued, no
 * payment made, Stripe untouched.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const web = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

const adminPage    = code(web('app/admin/payments/page.tsx'));
const refundUI     = code(web('components/admin/MembershipRefunds.tsx'));
const sidebar      = code(web('components/admin/AdminSidebar.tsx'));
const adminIndex   = code(web('app/admin/page.tsx'));
const adminLayout  = code(web('app/admin/layout.tsx'));
const adminServer  = code(web('lib/admin-data.server.ts'));
const refundFn     = code(read('supabase/functions/refund-payment/index.ts'));
const appDashboard = code(read('app/(admin)/dashboard.tsx'));
const appMe        = code(read('app/(tabs)/me.tsx'));

function rowsOf(out: string): Record<string, unknown>[] {
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
}
const runSql = (sql: string) => rowsOf(execFileSync('npx',
  ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }));

/* ── 1. reachable on the web ──────────────────────────────────────────────── */

describe('an admin can actually get to the refund control', () => {
  test('the page exists at a real route', () => {
    assert.ok(existsSync(join(WEB_ROOT, 'app/admin/payments/page.tsx')));
    assert.match(adminPage, /getMembershipPurchases/);
    assert.match(adminPage, /<MembershipRefunds/);
  });

  test('it is linked from the admin sidebar and the dashboard', () => {
    // Built-but-unlinked is the failure this whole file exists for.
    assert.match(sidebar, /href: "\/admin\/payments", label: "Payments"/);
    assert.match(adminIndex, /href: "\/admin\/payments", label: "Payments"/);
  });

  test('the whole admin area is behind the admin check', () => {
    assert.match(adminLayout, /await requireAdmin\(\)/);
    assert.match(adminServer, /if \(a\.profile\?\.role !== "admin"\) redirect\("\/account"\)/);
  });
});

/* ── 2. what it shows ─────────────────────────────────────────────────────── */

describe('the list identifies a payment by things a person knows', () => {
  test('customer, hub, tier, date, method, total and refund state', () => {
    for (const f of ['customerName', 'hub_name', 'tier_name', 'occurred_at', 'payment_method',
                     'refund_state', 'refunded_pence']) {
      assert.match(refundUI, new RegExp(f), `${f} is not shown`);
    }
    assert.match(refundUI, /Wallet.*Card|Card.*Wallet/s);
  });

  test('the modal states the total, what is refunded and what remains', () => {
    assert.match(refundUI, /Original total/);
    assert.match(refundUI, /Already refunded/);
    assert.match(refundUI, /Remaining refundable/);
  });

  test('a full refund and a partial refund are both offered on a card', () => {
    assert.match(refundUI, /Refund \{gbp\(remaining\)\} in full/);
    assert.match(refundUI, /or refund part of it/);
  });

  test('a wallet payment offers only the refund its ledger supports', () => {
    assert.match(refundUI, /walletOnlyFull/);
    assert.match(refundUI, /can only be refunded in full/);
  });

  test('refunding takes a deliberate second confirmation', () => {
    assert.match(refundUI, /setConfirming\(/);
    assert.match(refundUI, /Yes, refund/);
  });

  test('no Stripe or ledger identifier is ever rendered', () => {
    // payment_intent_id is used to ADDRESS the refund call; it must not be
    // displayed. Nothing else may appear at all.
    assert.doesNotMatch(refundUI, /\{purchase\.payment_intent_id\}|\{p\.payment_intent_id\}/);
    assert.doesNotMatch(refundUI, /stripe_transfer_id|refund_id|transaction_id/);
    assert.doesNotMatch(adminServer, /stripe_transfer_id/);
  });
});

/* ── 3. the backend is still the one that moves money ─────────────────────── */

describe('no refund logic was reimplemented on the web', () => {
  test('the page calls the existing admin-only function', () => {
    assert.match(refundUI, /functions\.invoke\("refund-payment"/);
  });

  test('and does not touch Stripe, the ledger or entitlement itself', () => {
    for (const re of [/api\.stripe\.com/, /reverse_transfer/, /refund_application_fee/,
                      /record_membership_refund/, /wallet_reverse_debit/, /apply_membership_entitlement/]) {
      assert.doesNotMatch(refundUI, re, 'refund logic has been duplicated client-side');
    }
  });

  test('the function still reverses the transfer and the platform fee', () => {
    assert.match(refundFn, /form\.set\('reverse_transfer', 'true'\)/);
    assert.match(refundFn, /form\.set\('refund_application_fee', 'true'\)/);
    assert.match(refundFn, /record_membership_refund/);
    assert.match(refundFn, /Forbidden — admins only/);
  });

  test('the amount is still decided by the server, not sent by the page', () => {
    assert.match(refundFn, /from\('hub_membership_purchases'\)/);
    assert.match(refundFn, /more than remains refundable/);
  });
});

/* ── 4. who may reach it ──────────────────────────────────────────────────── */

describe('only a platform admin gets in', () => {
  test('the server refuses every non-admin at the layout', () => {
    // Hiding a menu item is not a boundary; this redirects before any data is
    // read, and the Edge Function refuses independently of the UI.
    assert.match(adminServer, /if \(!a\) redirect\("\/sign-in\?next=\/admin"\)/);
    assert.match(adminServer, /role !== "admin"/);
  });

  test('the purchase read is not service-role — it runs as the admin', () => {
    const fn = adminServer.slice(adminServer.indexOf('export async function getMembershipPurchases'));
    assert.match(fn, /createServerClient\(\)/);
    assert.doesNotMatch(fn, /SERVICE_ROLE/);
  });

  test('exactly one production account holds platform admin, and RLS backs it', () => {
    const r = runSql(`select count(*)::text admins,
                             (select count(*)::text from pg_policies
                               where tablename = 'hub_membership_purchases'
                                 and qual ilike '%is_admin%') as admin_policy
                        from public.profiles where role = 'admin' or is_platform_owner;`)[0];
    assert.equal(r.admins, '1', 'the number of platform admins changed');
    assert.equal(r.admin_policy, '1', 'the admin read policy is missing');
  });
});

/* ── 5. the native screen, reported honestly ──────────────────────────────── */

describe('the native screen is correct but only reaches a published build', () => {
  test('it exists and is linked from the app admin dashboard', () => {
    assert.ok(existsSync(join(REPO_ROOT, 'components/admin/MembershipRefunds.tsx')));
    assert.match(appDashboard, /'payments':\s*'\/\(admin\)\/payments'/);
    assert.match(appMe, /profile\?\.role === 'admin'/);
    assert.match(appMe, /router\.push\('\/\(admin\)\/dashboard'\)/);
  });

  test('native updates travel by EAS Update, which a git push does not trigger', () => {
    const appJson = JSON.parse(read('app.json')) as { expo: { updates?: { url?: string } } };
    assert.match(appJson.expo.updates?.url ?? '', /u\.expo\.dev/,
      'if this stops being OTA the deployment note above needs revisiting');
  });
});

/* ── 6. nothing was spent proving any of this ─────────────────────────────── */

describe('the TEST purchase is untouched', () => {
  test('one live £10.95 Junior purchase, unrefunded', () => {
    const r = runSql(`select count(*)::text c,
                             coalesce(max(total_pence) filter (where source = 'live'),0)::text total,
                             coalesce(string_agg(distinct refund_state, ','),'-') as states
                        from public.hub_membership_purchases;`)[0];
    assert.equal(r.c, '2');
    assert.equal(r.total, '1095');
    assert.equal(r.states, 'none', 'a refund has been issued');
  });

  test('the membership it bought still runs to 2027', () => {
    const r = runSql(`select count(*)::text c from public.hub_members
                       where stripe_payment_intent_id is not null
                         and paid_until > now() and status = 'active';`)[0];
    assert.equal(r.c, '2');
  });
});
