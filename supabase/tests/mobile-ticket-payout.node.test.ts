/**
 * mobile-ticket-payout.node.test.ts — the ticket route, and central payouts on
 * mobile.
 *
 * TICKET CHECKOUT
 *
 * Tapping Get tickets crashed the app. The root ErrorBoundary in _layout.tsx
 * already renders any render-phase error with its message and stack, so a crash
 * with NOTHING on screen means the throw did not happen during render — React
 * error boundaries do not catch errors from event handlers, and the Get tickets
 * onPress is exactly that.
 *
 * Two things follow, and both are asserted here: the route the handler pushes
 * to must be registered like every other payment screen, and the push must
 * report a failure rather than take the app down silently. A crash nobody can
 * read is a bug you cannot fix.
 *
 * CENTRAL PAYOUTS
 *
 * Mobile had no UI for the bank account at all — only the card. The product
 * model is one card for everything you pay and one bank account for everything
 * you are paid, with businesses inheriting that bank unless explicitly given
 * their own. The account screen now shows both, from the same derivation the
 * website uses, and starting Connect goes through the existing
 * create-connect-account function so no second account can be made.
 *
 * SAFETY
 * Source inspection plus rolled-back SQL fixtures. No Stripe call, no payment,
 * no production row.
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
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');

function rowsOf(out: string): Record<string, unknown>[] {
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
}
const runSql = (sql: string) => rowsOf(execFileSync('npx',
  ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }));
const one = (sql: string) => runSql(sql)[0] ?? {};

// ── 1. The ticket route ────────────────────────────────────────────────────

describe('Get tickets opens a route that exists', () => {
  const detail = () => read('app/events/[id].tsx');
  const checkout = () => read('app/event-ticket-checkout.tsx');
  const layout = () => read('app/_layout.tsx');

  test('the route file exists and the param names match', () => {
    assert.ok(existsSync(join(REPO_ROOT, 'app', 'event-ticket-checkout.tsx')));
    assert.match(detail(), /pathname: '\/event-ticket-checkout', params: \{ id: event\.id \}/);
    assert.match(checkout(), /useLocalSearchParams<\{ id: string \}>\(\)/);
  });

  test('the route is registered in the Stack like every other payment screen', () => {
    const src = layout();
    for (const route of ['event-ticket-checkout', 'product-checkout', 'payment-setup', 'local-wallet']) {
      assert.match(src, new RegExp(`<Stack\\.Screen name="${route}"`),
        `${route} is not declared alongside its siblings`);
    }
  });

  test('a navigation failure is reported, not swallowed and not fatal', () => {
    const src = detail();
    assert.match(src, /const openTicketCheckout = \(\) => \{/);
    assert.match(src, /console\.error\('\[events\/\[id\]\] could not open ticket checkout:'/,
      'the real error must reach the log');
    assert.match(src, /alert\(\{/, 'and the user must be told something rather than losing the app');
    assert.ok(/import \{ useAlert \}/.test(src) && /const \{ alert \} = useAlert\(\)/.test(src),
      'the branded alert must be the one in scope — the DOM global alert does not exist in React Native');
  });

  test('the checkout screen handles every state it can be opened in', () => {
    const src = checkout();
    assert.match(src, /if \(loading\)/, 'loading');
    assert.match(src, /if \(!event\)/, 'missing event');
    assert.match(src, /ticketTypes\.length === 0/, 'no active ticket types');
    assert.match(src, /use_saved_card: !!profile\.has_payment_method/,
      'a buyer with no saved card falls through to the payment sheet');
  });

  test('opening the screen takes no money', () => {
    const src = checkout();
    // Every purchase call must sit behind a user action, never a mount effect.
    const mountEffects = [...src.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\}, \[/g)].map((m) => m[1]);
    for (const body of mountEffects) {
      for (const call of ['purchaseTickets', 'confirmTicketPurchase', 'presentPaymentSheet']) {
        assert.ok(!body.includes(call), `${call} must not run just because the screen opened`);
      }
    }
  });

  test('the SCA path is still reachable when a purchase is made', () => {
    // The Step-15 architecture must survive: the API layer settles a challenge.
    assert.match(read('lib/events-api.ts'), /settleSavedCardPayment/);
  });
});

// ── 2. Central payouts on mobile ───────────────────────────────────────────

describe('mobile shows the central bank account', () => {
  const helper = () => read('lib/payment-state.ts');
  const account = () => read('app/account.tsx');

  test('card and payout state are independent booleans', () => {
    const src = helper();
    for (const f of ['card_on_file', 'payouts_connected', 'payouts_pending']) {
      assert.match(src, new RegExp(f), `${f} missing`);
    }
    // A card must never imply a bank account, or vice versa.
    assert.match(src, /card_on_file:\s*!!prof\?\.has_payment_method/);
    assert.ok(!/payouts_connected:\s*!!prof\?\.has_payment_method/.test(src));
  });

  test('payout state coalesces both places a Connect account can live', () => {
    const src = helper();
    assert.match(src, /driver_profiles/,
      'a driver who connected in the app keeps their account on driver_profiles');
    assert.match(src, /from\('profiles'\)/);
  });

  test('no Stripe identifier is handed to a screen', () => {
    const src = helper();
    const returned = src.slice(src.indexOf('return {'), src.indexOf('startPayoutOnboarding'));
    for (const leak of ['stripe_account_id', 'stripe_customer_id', 'acct_', 'cus_']) {
      assert.ok(!returned.includes(leak), `payment state must not expose ${leak}`);
    }
  });

  test('the account screen uses the shared derivation and shows both', () => {
    const src = account();
    assert.match(src, /fetchPaymentState/, 'one derivation, not a per-screen rule');
    assert.match(src, /payouts_connected/);
    assert.match(src, /Bank connected — payouts active/);
    assert.match(src, /No bank account|Connect bank account/);
  });

  test('connecting goes through the existing function, which cannot duplicate an account', () => {
    assert.match(helper(), /invoke\('create-connect-account'\)/);
    // That function resolves an existing account from profiles then
    // driver_profiles before creating anything.
    const fn = read('supabase/functions/create-connect-account/index.ts');
    assert.match(fn, /already_complete/);
    assert.match(fn, /driver_profiles/);
  });

  test('mobile never touches a business-specific payout account', () => {
    const src = helper();
    assert.ok(!/local_businesses/.test(src),
      'central payout management must not reach into a business’s own Connect account');
  });
});

// ── 3. Inheritance and override still hold ─────────────────────────────────

describe('central payout inheritance is unchanged', () => {
  test('a business with no payout of its own inherits the owner’s; one with its own overrides', () => {
    const r = one(`
      begin;
      create temp table t(label text, dest text);
      do $$
      declare u uuid; b_inh uuid; b_own uuid; e_inh uuid; e_own uuid;
      begin
        select id into u from auth.users limit 1;
        update public.profiles
           set stripe_account_id='acct_central_probe', stripe_payouts_enabled=true where id=u;
        b_inh := gen_random_uuid(); b_own := gen_random_uuid();
        insert into public.local_businesses (id,name,category,address,slug,owner_id,use_business_payout,payout_enabled,stripe_account_id)
        values (b_inh,'P Inherit','other','Lerwick','p-inh-'||left(b_inh::text,8),u,false,false,null),
               (b_own,'P Own','other','Lerwick','p-own-'||left(b_own::text,8),u,true,true,'acct_business_probe');
        e_inh := gen_random_uuid(); e_own := gen_random_uuid();
        insert into public.events (id,title,status,organiser_business_id,starts_at,has_tickets)
        values (e_inh,'P inh ev','published',b_inh, now()+interval '9 days', true),
               (e_own,'P own ev','published',b_own, now()+interval '9 days', true);
        insert into public.event_ticket_types (id,event_id,name,price_pence,is_active)
        values (gen_random_uuid(),e_inh,'Std',1000,true),
               (gen_random_uuid(),e_own,'Std',1000,true);
        insert into t select 'inherit', d.account_id from public.event_payout_destination(e_inh) d;
        insert into t select 'override', d.account_id from public.event_payout_destination(e_own) d;
      end $$;
      select (select dest from t where label='inherit')  as inherit,
             (select dest from t where label='override') as override;`);
    assert.equal(r.inherit, 'acct_central_probe',
      'a business with no bank of its own must be paid through its owner’s central account');
    assert.equal(r.override, 'acct_business_probe',
      'a business with its own bank must keep being paid into it');
  });
});
