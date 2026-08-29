/**
 * card-removal.node.test.ts — taking a card off the account, truthfully.
 *
 * Paygate 13 readiness found Remove card already worked and its ownership was
 * sound. It also found four ways the state around it could stop being true:
 *
 *   1. The Customer's invoice_settings.default_payment_method was never
 *      cleared, and defaultCardFor returned it without checking it was still
 *      attached. A detached PaymentMethod is PERMANENTLY unusable — Stripe:
 *      "once detached, a PaymentMethod can no longer be used for payments or
 *      re-attached to a Customer" — and Stripe's reference does not say whether
 *      detaching clears the default. So every saved-card rail could be handed a
 *      dead card, and ADDING a new one would not have fixed it: the stale
 *      default won the first branch every time.
 *   2. A subscription billed through the personal Customer kept its own
 *      default_payment_method, which takes precedence. After remove-then-add it
 *      was still holding the detached card.
 *   3. The detach loop threw on the first failure, before the local flag was
 *      re-derived — describing the operation we intended, not the one that
 *      happened.
 *   4. The named-card mode answered 404 on a retry after a lost response.
 *
 * The Stripe-facing helpers are exercised directly against a stub transport,
 * because the question is what the code DOES with Stripe's answers.
 *
 * Run: npm test
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  defaultCardFor, listAttachedCards, reconcileCustomerDefault, setCustomerDefaultCard,
} from '../functions/_shared/saved-card.ts';
import { personalSubscriptionsFor, repointSubscriptions } from '../functions/_shared/personal-subscriptions.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT  = join(REPO_ROOT, '..', 'oneshetland-web');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

const read    = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');

const removeFn  = code(read('supabase/functions/remove-card/index.ts'));
const confirmFn = code(read('supabase/functions/confirm-card-setup/index.ts'));
const migration = read('supabase/migrations/20260912120000_card_funded_subscription.sql');
const webCard   = code(readWeb('components/payments/CardSetup.tsx'));
const webPage   = code(readWeb('app/account/payments/page.tsx'));
const appAcct   = code(read('app/account.tsx'));
const appSetup  = code(read('app/payment-setup.tsx'));

function sql(body: string): Record<string, unknown>[] {
  const out = execFileSync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const parsed = JSON.parse(out) as { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 300));
  return parsed.rows ?? [];
}

/* ── A Stripe stub, so the helpers can be run rather than read ───────────── */

const CUS = 'cus_probe';
type Call = { url: string; method: string; body: string };

function stubStripe(state: {
  cards: string[];
  def: string | null;
  subs?: Record<string, { customer: string; status: string; default_payment_method: string | null }>;
  detachFails?: Set<string>;
  listFails?: boolean;
  defaultWriteIsIgnored?: boolean;
}) {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = String(init?.body ?? '');
    calls.push({ url, method, body });
    const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    const bad = (m: string, status = 400) =>
      new Response(JSON.stringify({ error: { message: m } }), { status });

    if (url.includes('/payment_methods') && url.includes('/detach')) {
      const pm = url.split('/payment_methods/')[1].split('/')[0];
      if (state.detachFails?.has(pm)) return bad('card could not be detached');
      state.cards = state.cards.filter((c) => c !== pm);
      return ok({ id: pm, customer: null });
    }
    if (url.includes('/payment_methods?')) {
      if (state.listFails) return bad('stripe unavailable', 500);
      return ok({ data: state.cards.map((id) => ({ id })) });
    }
    if (url.includes('/setup_intents/')) {
      return ok({ id: 'seti_x', customer: CUS, payment_method: state.cards[0] ?? null });
    }
    if (url.includes('/subscriptions/')) {
      const id = url.split('/subscriptions/')[1];
      const sub = state.subs?.[id];
      if (!sub) return bad('no such subscription', 404);
      if (method === 'POST') {
        const v = new URLSearchParams(body).get('default_payment_method');
        sub.default_payment_method = v === '' ? null : v;
        return ok({ id, ...sub });
      }
      return ok({ id, ...sub });
    }
    if (url.includes(`/customers/${CUS}`)) {
      if (method === 'POST') {
        if (!state.defaultWriteIsIgnored) {
          const v = new URLSearchParams(body).get('invoice_settings[default_payment_method]');
          state.def = v === '' ? null : v;
        }
        return ok({ id: CUS, invoice_settings: { default_payment_method: state.def } });
      }
      return ok({ id: CUS, invoice_settings: { default_payment_method: state.def } });
    }
    return bad(`unexpected ${url}`, 404);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

/* ── 1. A stale default is never handed out ─────────────────────────────── */

describe('the stored default is a preference, not a fact', () => {
  test('a default that is still attached is used', async () => {
    const s = stubStripe({ cards: ['pm_a', 'pm_b'], def: 'pm_b' }); restore = s.restore;
    assert.equal(await defaultCardFor('sk', CUS), 'pm_b');
  });

  test('THE DEFECT: a default that has been detached is not returned', async () => {
    const s = stubStripe({ cards: ['pm_b'], def: 'pm_dead' }); restore = s.restore;
    const got = await defaultCardFor('sk', CUS);
    assert.notEqual(got, 'pm_dead', 'a permanently unusable card was handed to a payment rail');
    assert.equal(got, 'pm_b', 'it falls through to a card that actually exists');
  });

  test('and the stale default is repaired at the same time', async () => {
    const state = { cards: ['pm_b'], def: 'pm_dead' };
    const s = stubStripe(state); restore = s.restore;
    await defaultCardFor('sk', CUS);
    assert.equal(state.def, 'pm_b', 'the Customer is left pointing at a real card');
  });

  test('no attached cards means no saved card, whatever the default says', async () => {
    const s = stubStripe({ cards: [], def: 'pm_dead' }); restore = s.restore;
    assert.equal(await defaultCardFor('sk', CUS), null);
  });

  test('an unreadable list is not read as "no cards"', async () => {
    const s = stubStripe({ cards: ['pm_a'], def: 'pm_a', listFails: true }); restore = s.restore;
    assert.equal(await listAttachedCards('sk', CUS), null, 'null means unknown, not empty');
    assert.equal(await defaultCardFor('sk', CUS), null, 'and no card is charged on a guess');
  });

  test('the write is verified rather than assumed', async () => {
    // Stripe does not document unsetting this field. If the write silently did
    // nothing, the helper must say so instead of reporting success.
    const s = stubStripe({ cards: ['pm_a'], def: 'pm_a', defaultWriteIsIgnored: true }); restore = s.restore;
    const r = await setCustomerDefaultCard('sk', CUS, null);
    assert.equal(r.ok, false, 'an ignored write must not be reported as done');
    assert.equal(r.now, 'pm_a', 'and the caller is told what is actually there');
  });
});

/* ── 2. Reconciling the default against reality ─────────────────────────── */

describe('the default follows the cards that remain', () => {
  test('no cards left → cleared', async () => {
    const state = { cards: [] as string[], def: 'pm_gone' };
    const s = stubStripe(state); restore = s.restore;
    const r = await reconcileCustomerDefault('sk', CUS, []);
    assert.equal(state.def, null);
    assert.equal(r.default, null);
    assert.equal(r.ok, true);
  });

  test('the default survived → left alone', async () => {
    const state = { cards: ['pm_a', 'pm_b'], def: 'pm_b' };
    const s = stubStripe(state); restore = s.restore;
    const r = await reconcileCustomerDefault('sk', CUS, [{ id: 'pm_a' }, { id: 'pm_b' }]);
    assert.equal(r.changed, false);
    assert.equal(state.def, 'pm_b');
    assert.equal(s.calls.filter((c) => c.method === 'POST').length, 0, 'a valid default is not rewritten');
  });

  test('the default went but others remain → a deterministic survivor is promoted', async () => {
    const state = { cards: ['pm_new', 'pm_old'], def: 'pm_gone' };
    const s = stubStripe(state); restore = s.restore;
    const r = await reconcileCustomerDefault('sk', CUS, [{ id: 'pm_new' }, { id: 'pm_old' }]);
    assert.equal(r.default, 'pm_new', 'newest first, the same choice every time');
    assert.equal(state.def, 'pm_new');
  });
});

/* ── 3. Subscriptions the personal card pays for ────────────────────────── */

const subsFixture = () => ({
  sub_mine:    { customer: CUS,         status: 'active',   default_payment_method: 'pm_dead' },
  sub_other:   { customer: 'cus_other', status: 'active',   default_payment_method: 'pm_theirs' },
  sub_over:    { customer: CUS,         status: 'canceled', default_payment_method: 'pm_dead' },
});

describe('a new card repairs what the old one was paying for', () => {
  test('an active subscription on this customer is repointed', async () => {
    const subs = subsFixture();
    const s = stubStripe({ cards: ['pm_new'], def: 'pm_new', subs }); restore = s.restore;
    const out = await repointSubscriptions('sk', [{ businessId: 'b', subscriptionId: 'sub_mine' }], CUS, 'pm_new');
    assert.equal(out[0].result, 'repointed');
    assert.equal(subs.sub_mine.default_payment_method, 'pm_new');
  });

  test('a subscription billed by a different customer is never touched', async () => {
    const subs = subsFixture();
    const s = stubStripe({ cards: ['pm_new'], def: 'pm_new', subs }); restore = s.restore;
    const out = await repointSubscriptions('sk', [{ businessId: 'b', subscriptionId: 'sub_other' }], CUS, 'pm_new');
    assert.equal(out[0].result, 'skipped');
    assert.equal(subs.sub_other.default_payment_method, 'pm_theirs', 'somebody else\'s subscription is left alone');
  });

  test('a finished subscription is skipped rather than poked', async () => {
    const subs = subsFixture();
    const s = stubStripe({ cards: ['pm_new'], def: 'pm_new', subs }); restore = s.restore;
    const out = await repointSubscriptions('sk', [{ businessId: 'b', subscriptionId: 'sub_over' }], CUS, 'pm_new');
    assert.equal(out[0].result, 'skipped');
  });

  test('removal clears it, and only that field is ever written', async () => {
    const subs = subsFixture();
    const s = stubStripe({ cards: [], def: null, subs }); restore = s.restore;
    await repointSubscriptions('sk', [{ businessId: 'b', subscriptionId: 'sub_mine' }], CUS, null);
    assert.equal(subs.sub_mine.default_payment_method, null);
    const writes = s.calls.filter((c) => c.method === 'POST' && c.url.includes('/subscriptions/'));
    for (const w of writes) {
      const keys = [...new URLSearchParams(w.body).keys()];
      assert.deepEqual(keys, ['default_payment_method'],
        'plan, price and status must not be touched by card management');
    }
  });

  test('ownership comes from our own records, not from "everything on this customer"', () => {
    const src = code(read('supabase/functions/_shared/personal-subscriptions.ts'));
    assert.match(src, /\.eq\('owner_id', userId\)/);
    assert.match(src, /\.eq\('stripe_customer_id', customerId\)/);
    assert.ok(!/\/v1\/subscriptions\?customer=/.test(src) && !/subscriptions\.list/.test(src),
      'listing Stripe subscriptions would reach objects this product did not create');
  });
});

/* ── 4. The endpoint's own guarantees ───────────────────────────────────── */

describe('remove-card converges on what Stripe actually holds', () => {
  test('the local flag is derived AFTER the detaches, from a fresh read', () => {
    const detach = removeFn.indexOf('/detach');
    const after  = removeFn.indexOf('const after = await listAttachedCards');
    const flag   = removeFn.indexOf('has_payment_method: hasCard');
    assert.ok(detach > 0 && after > detach && flag > after,
      'the flag must reflect Stripe truth, not the operation we intended');
  });

  test('a partial failure still reconciles before it reports', () => {
    const loop = removeFn.slice(removeFn.indexOf('for (const card of before)'), removeFn.indexOf('const after ='));
    assert.ok(!/throw/.test(loop), 'one failed detach must not skip the reconciliation');
    assert.match(removeFn, /failures\.push/);
    const report = removeFn.indexOf('failures.length > 0');
    assert.ok(report > removeFn.indexOf('has_payment_method: hasCard'),
      'the honest error is returned only after local state is true');
  });

  test('an unreadable Stripe writes no flag at all', () => {
    assert.match(removeFn, /if \(after === null\)[\s\S]{0,400}UNRESOLVED/);
    const guard = removeFn.indexOf('after === null');
    assert.ok(guard < removeFn.indexOf('has_payment_method: hasCard'));
  });

  test('the default is reconciled on every path', () => {
    assert.match(removeFn, /reconcileCustomerDefault\(stripeKey, customerId, after\)/);
  });

  test('the unused named-card mode is gone', () => {
    assert.ok(!/payment_method_id/.test(removeFn),
      'an unused input taking a client-supplied Stripe id is surface for nothing');
    for (const [name, src] of [['web', webCard], ['mobile', appAcct]] as const) {
      assert.ok(!/payment_method_id/.test(src), `${name} must not have started sending one`);
    }
  });

  test('remove-all is idempotent: a second call has nothing to do and says ok', () => {
    // With no cards attached the loop runs zero times, the reconcile clears an
    // already-clear default, and the flag is derived as false.
    assert.match(removeFn, /for \(const card of before\)/);
    assert.ok(!/if \(before\.length === 0\)[\s\S]{0,120}(return json\(\{ error|404)/.test(removeFn),
      'an empty card list is an ordinary success, not an error');
  });
});

describe('confirm-card-setup makes the new card the one we use', () => {
  test('the card comes from the SetupIntent, not from a guess', () => {
    assert.match(confirmFn, /setup_intents\/\$\{setupIntentId\}/);
    assert.match(confirmFn, /si\?\.customer === customerId/);
    assert.match(confirmFn, /attached\.some\(\(c\) => c\.id === pm\)/);
  });

  test('an intent naming another customer is refused, not adopted', () => {
    const block = confirmFn.slice(confirmFn.indexOf('if (setupIntentId)'));
    assert.match(block, /else \{[\s\S]{0,200}did not match this customer/);
  });

  test('the newly confirmed card becomes the Customer default', () => {
    assert.ok(confirmFn.indexOf('newCard') < confirmFn.indexOf('setCustomerDefaultCard(stripeKey, customerId, newCard)'));
  });

  test('and the personal subscriptions are repointed to it', () => {
    assert.match(confirmFn, /personalSubscriptionsFor\(svc, user\.id, customerId\)/);
    assert.match(confirmFn, /repointSubscriptions\(stripeKey, subs, customerId, newCard\)/);
  });

  test('the business branch is never repointed through the personal path', () => {
    const block = confirmFn.slice(confirmFn.indexOf('if (newCard)'));
    assert.match(block, /if \(!businessId\) \{[\s\S]{0,600}personalSubscriptionsFor/);
  });
});

/* ── 5. Boundaries ──────────────────────────────────────────────────────── */

describe('none of this crosses a boundary it should not', () => {
  test('the customer is resolved from the caller, never from the body', () => {
    for (const [name, src] of [['remove-card', removeFn], ['confirm-card-setup', confirmFn]] as const) {
      assert.match(src, /\.select\('stripe_customer_id'\)\.eq\('id', user\.id\)/, `${name} personal branch`);
      assert.match(src, /biz\.owner_id !== user\.id/, `${name} business branch`);
      assert.ok(!/body\?\.(stripe_)?customer/.test(src), `${name} reads a customer from the body`);
    }
  });

  test('the personal path cannot reach a business customer, and vice versa', () => {
    const personal = removeFn.slice(removeFn.indexOf('} else {'), removeFn.indexOf('if (!customerId)'));
    assert.ok(!/business_stripe_customer_id/.test(personal));
    assert.ok(!/stripe_account_id|connect/i.test(removeFn), 'payout information is never touched');
  });

  test('the warning RPC hands back a boolean and nothing else', () => {
    assert.match(migration, /returns boolean/);
    assert.match(migration, /b\.owner_id = auth\.uid\(\)/);
    assert.match(migration, /b\.stripe_customer_id is not distinct from p\.stripe_customer_id/);
    assert.ok(!/returns table|jsonb/.test(migration), 'no ids may leave this function');
  });

  test('it is callable by a signed-in user and not anonymously', () => {
    const [row] = sql(`
      select coalesce(has_function_privilege('authenticated', p.oid, 'execute'), false) as auth_can,
             coalesce(has_function_privilege('anon', p.oid, 'execute'), false)          as anon_can
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname='has_card_funded_subscription';`);
    assert.equal(row.auth_can, true);
    assert.equal(row.anon_can, false);
  });

  test('it only answers for the caller, and only for a personal-customer subscription', () => {
    const [row] = sql(`
begin;
  insert into auth.users (id, email) values
    ('dddd1111-1111-1111-1111-111111111111','sub-owner@probe.invalid'),
    ('dddd2222-2222-2222-2222-222222222222','stranger@probe.invalid');
  update public.profiles set stripe_customer_id = 'cus_probe_owner'
   where id = 'dddd1111-1111-1111-1111-111111111111';
  insert into public.local_businesses (id, owner_id, name, category, address, is_active,
                                      stripe_subscription_id, stripe_customer_id, subscription_until)
  values ('dddd3333-3333-3333-3333-333333333333','dddd1111-1111-1111-1111-111111111111',
          'PROBE Co', 'other', 'PROBE', true, 'sub_probe', 'cus_probe_owner', now() + interval '20 days');

  -- Each answer is captured as the role that asked it; only the last SELECT of
  -- a script comes back, so they are collected and reported together.
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"dddd1111-1111-1111-1111-111111111111","role":"authenticated"}';
  create temp table _a on commit drop as select public.has_card_funded_subscription() as v;
  reset role;

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"dddd2222-2222-2222-2222-222222222222","role":"authenticated"}';
  create temp table _b on commit drop as select public.has_card_funded_subscription() as v;
  reset role;

  -- Now give the business its OWN Stripe Customer: the personal card no longer
  -- funds it, so the warning must stop applying.
  update public.local_businesses set stripe_customer_id = 'cus_probe_business'
   where id = 'dddd3333-3333-3333-3333-333333333333';
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"dddd1111-1111-1111-1111-111111111111","role":"authenticated"}';
  create temp table _c on commit drop as select public.has_card_funded_subscription() as v;
  reset role;

  select (select v from _a) as owner_sees,
         (select v from _b) as stranger_sees,
         (select v from _c) as owner_after_business_card;
rollback;`);
    assert.equal(row.owner_sees, true, 'the owner is warned');
    assert.equal(row.stranger_sees, false, 'nobody else is');
    assert.equal(row.owner_after_business_card, false,
      'a business paying with its own card raises no personal warning');
  });
});

/* ── 6. What the person is told ─────────────────────────────────────────── */

describe('the confirmation says what actually happens', () => {
  test('web warns only when a subscription renews on this card', () => {
    assert.match(webCard, /fundsSubscription && !businessId/);
    assert.match(webCard, /active subscription that renews on this card/);
    assert.match(webCard, /add another card before the next renewal/);
    assert.match(webCard, /You can add one again any time/, 'the ordinary case keeps its plain wording');
  });

  test('mobile says the same thing', () => {
    assert.match(appAcct, /active subscription that renews on this card/);
    assert.match(appAcct, /add another card before the next renewal/);
    assert.match(appAcct, /has_card_funded_subscription/);
  });

  test('the page asks the server, not the client', () => {
    assert.match(webPage, /rpc\("has_card_funded_subscription"\)/);
    assert.match(webPage, /fundsSubscription=\{fundsSubscription\}/);
  });

  test('no Stripe identifier reaches either screen', () => {
    for (const [name, src] of [['web', webCard], ['mobile', appAcct]] as const) {
      assert.ok(!/\bcus_|\bsub_|\bpm_/.test(src), `${name} exposes a Stripe id`);
    }
  });

  test('nothing blocks removal — it is a warning, not a gate', () => {
    assert.ok(!/fundsSubscription[\s\S]{0,200}return;/.test(webCard), 'web must not refuse');
    assert.ok(!/if \(fundsSubscription\)[\s\S]{0,160}return;/.test(appAcct), 'mobile must not refuse');
    assert.ok(!/has_card_funded_subscription|funds_subscription/.test(removeFn),
      'and the backend must not depend on the warning for safety');
  });

  test('both clients hand the server the SetupIntent they just confirmed', () => {
    assert.match(webCard, /setup_intent_id: setupIntent\.id/);
    assert.match(appSetup, /setup_intent_id: String\(data\.client_secret\)\.split\('_secret_'\)\[0\]/);
  });
});
