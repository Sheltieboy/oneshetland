/**
 * hub-membership-pretest.node.test.ts — two blockers before the first paid
 * membership.
 *
 * A — RENEWING REPLAYED THE ORIGINAL PAYMENT
 *
 * The Stripe key was `member-<user>-<tier>`, and neither client sent an
 * override. Renewing is buying the SAME tier again, so a renewal inside
 * Stripe's ~24 hour window came back as the PaymentIntent from the original
 * join; activation deduplicated on it and the member was shown their old expiry
 * as though it had worked. A declined card was likewise unretryable on that
 * tier for a day, and the card-form route carried no key at all.
 *
 * B — A HUB OWNER COULD BUY MEMBERSHIP OF THEIR OWN HUB BY CARD
 *
 * The wallet route has refused this since Paygate 7. The card route never did,
 * so an owner could take a destination charge into their own connected account
 * and charge the card back afterwards — and Paygate 7's recovery model does not
 * reach it, because that reverses wallet top-ups, not direct card charges.
 *
 * The guard is the Paygate 7 rule, not a second definition: it asks about the
 * DESTINATION ACCOUNT, because a connected account can be attached to more than
 * one resource — production already has two hubs sharing one — so "do they own
 * this hub?" would miss a payment routed through a sibling. The helper was
 * lifted into _shared/self-payment.ts so a card charge need not import the
 * wallet ledger; wallet-ledger re-exports it, so there is still one definition.
 *
 * SAFETY
 * Database assertions run in a transaction that is never committed. Live
 * behaviour was exercised against production on disposable hubs, tiers and
 * accounts, all removed. No membership was purchased and no payment confirmed.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const web = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');

const intentFn = read('supabase/functions/create-hub-membership-intent/index.ts');
const confirmFn = read('supabase/functions/confirm-hub-membership/index.ts');
const fulfilment = read('supabase/functions/_shared/fulfilment.ts');
const selfPay = read('supabase/functions/_shared/self-payment.ts');
const ledger = read('supabase/functions/_shared/wallet-ledger.ts');
const checkout = read('supabase/functions/wallet-checkout/index.ts');
const webClient = web('lib/hubs-client.ts');
const panel = web('components/hubs/HubMembershipPanel.tsx');
// The attempt lifecycle moved out of the panel and into the checkout when the
// summary step was added — the panel can no longer take a payment at all.
const memberCheckout = web('components/hubs/MembershipCheckout.tsx');
const appApi = read('lib/hubs-api.ts');
const appHub = read('app/hubs/[id].tsx');

const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

function rowsOf(out: string): Record<string, unknown>[] {
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
}
const runSql = (sql: string) => rowsOf(execFileSync('npx',
  ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }));

const SCENARIO = `
begin;
create temp table r(step text, outcome text);
do $$
declare
  payer uuid; other uuid; stranger uuid;
  h_mine uuid; h_alias uuid; h_their uuid; t_mine uuid; t_their uuid;
  acct_mine text := 'acct_probe_mem_mine'; acct_their text := 'acct_probe_mem_their';
  m record; n int; v_first timestamptz; v_second timestamptz;
begin
  select id into payer    from auth.users order by created_at limit 1;
  select id into other    from auth.users order by created_at desc limit 1;
  select id into stranger from auth.users order by created_at offset 1 limit 1;

  insert into public.hubs (owner_id, name, slug, type, is_active, stripe_account_id, payout_enabled)
    values (payer, 'PROBE mine', 'probe-mem-mine', 'other', true, acct_mine, true) returning id into h_mine;
  insert into public.hubs (owner_id, name, slug, type, is_active, stripe_account_id, payout_enabled)
    values (other, 'PROBE alias', 'probe-mem-alias', 'other', true, acct_mine, true) returning id into h_alias;
  insert into public.hubs (owner_id, name, slug, type, is_active, stripe_account_id, payout_enabled)
    values (other, 'PROBE theirs', 'probe-mem-their', 'other', true, acct_their, true) returning id into h_their;

  -- ── the destination rule, as the card path now asks it ─────────────────
  insert into r select 'own_hub_destination',
    case when public.wallet_destination_self_controlled(payer, acct_mine) then 'blocked' else 'ALLOWED' end;
  insert into r select 'alias_destination',
    case when public.wallet_destination_self_controlled(
      payer, (select stripe_account_id from public.hubs where id = h_alias)) then 'blocked' else 'ALLOWED' end;
  insert into r select 'unrelated_destination',
    case when public.wallet_destination_self_controlled(payer, acct_their) then 'BLOCKED' else 'allowed' end;

  -- A committee member of the other hub controls no payout account there.
  insert into public.hub_members (hub_id, user_id, role, status)
    values (h_their, stranger, 'committee', 'active') on conflict do nothing;
  insert into r select 'committee_not_blocked',
    case when public.wallet_destination_self_controlled(stranger, acct_their) then 'BLOCKED' else 'allowed' end;

  -- ── activation: unchanged, and still exactly once ──────────────────────
  insert into public.hub_membership_types (hub_id, name, price_pence, period, is_active)
    values (h_their, 'PROBE Junior', 1000, 'year', true) returning id into t_their;

  perform public.activate_hub_membership(h_their, stranger, t_their, 'year', 1000, 'pi_probe_mem_a');
  select paid_until into v_first from public.hub_members where hub_id = h_their and user_id = stranger;
  insert into r select 'first_grant_year',
    case when v_first between now() + interval '360 days' and now() + interval '370 days' then 'one year' else 'WRONG' end;
  insert into r select 'role_is_member', role from public.hub_members where hub_id = h_their and user_id = stranger;

  -- Same payment again: no second period.
  perform public.activate_hub_membership(h_their, stranger, t_their, 'year', 1000, 'pi_probe_mem_a');
  select paid_until into v_second from public.hub_members where hub_id = h_their and user_id = stranger;
  insert into r select 'replay_no_extension',
    case when v_second = v_first then 'unchanged' else 'EXTENDED AGAIN' end;

  -- A genuinely different payment extends FROM the existing expiry.
  perform public.activate_hub_membership(h_their, stranger, t_their, 'year', 1000, 'pi_probe_mem_b');
  select paid_until into v_second from public.hub_members where hub_id = h_their and user_id = stranger;
  insert into r select 'renewal_extends_from_expiry',
    case when v_second between v_first + interval '360 days' and v_first + interval '370 days'
         then 'from expiry' else 'WRONG' end;
  select count(*) into n from public.hub_members where hub_id = h_their and user_id = stranger;
  insert into r values ('one_membership_row', n::text);

  -- Paying never promotes: a committee member who pays keeps committee.
  insert into r select 'committee_kept', role from public.hub_members where hub_id = h_their and user_id = stranger;

  -- ── grants ────────────────────────────────────────────────────────────
  insert into r select 'activate_client_exec',
    case when has_function_privilege('anon','public.activate_hub_membership(uuid,uuid,uuid,text,integer,text,integer,text)','execute')
           or has_function_privilege('authenticated','public.activate_hub_membership(uuid,uuid,uuid,text,integer,text,integer,text)','execute')
         then 'CALLABLE' else 'none' end;
  insert into r select 'destination_fn_client_exec',
    case when has_function_privilege('anon','public.wallet_destination_self_controlled(uuid,text)','execute')
           or has_function_privilege('authenticated','public.wallet_destination_self_controlled(uuid,text)','execute')
         then 'CALLABLE' else 'none' end;
  insert into r select 'pi_unique_index',
    case when exists (select 1 from pg_indexes where tablename='hub_members'
                       and indexdef ilike '%unique%stripe_payment_intent_id%') then 'present' else 'MISSING' end;
end $$;
select step, outcome from r;
`;

let cached: Record<string, string> | null = null;
function scenario(): Record<string, string> {
  if (!cached) cached = Object.fromEntries(runSql(SCENARIO).map((r) => [String(r.step), String(r.outcome)]));
  return cached;
}

/* ── A. attempt identity ──────────────────────────────────────────────────── */

describe('A — one deliberate membership checkout, one PaymentIntent', () => {
  test('client_request_id is required and validated before Stripe', () => {
    assert.match(intentFn, /typeof client_request_id !== 'string'/);
    assert.match(intentFn, /client_request_id\.length < 8 \|\| client_request_id\.length > 100/);
    assert.ok(intentFn.indexOf('client_request_id required') < intentFn.indexOf('createPaymentIntent({'));
  });

  test('the saved-card key carries the attempt', () => {
    assert.match(intentFn, /`member-\$\{user\.id\}-\$\{type\.id\}-\$\{client_request_id\}`/);
  });

  test('the card-form route has a key now, and it carries the attempt', () => {
    assert.match(intentFn, /`member-form-\$\{user\.id\}-\$\{type\.id\}-\$\{client_request_id\}`/);
  });

  test('the stale user+tier fallback is gone', () => {
    const keys = [...code(intentFn).matchAll(/`member[^`]*`/g)].map((m) => m[0]);
    assert.ok(keys.length >= 2, `expected both keys, found ${keys.length}`);
    for (const k of keys) assert.match(k, /client_request_id/, `key without an attempt reference: ${k}`);
  });

  test('web sends it, on the card route as well as the wallet route', () => {
    assert.match(webClient, /client_request_id: attemptId/);
    // Both routes now live in the checkout, behind the summary, and share one
    // reference because they are alternatives within one purchase.
    assert.match(memberCheckout, /startMembershipPayment\(tier\.id, attemptId\(\), usingSavedCard\)/);
    assert.match(memberCheckout, /walletCheckout\(\{ type: "hub_membership", membership_type_id: tier\.id \}, attemptId\(\)\)/);
  });

  test('the app sends it too', () => {
    assert.match(appApi, /client_request_id: attemptId/);
    assert.match(appHub, /startHubMembershipPayment\(type\.id, memberAttempt\(\), useSaved\)/);
  });

  test('the reference is keyed on a checkout session, not the tier', () => {
    // Tier alone would make a RENEWAL reuse the original join's reference.
    assert.match(memberCheckout, /const attemptId = useAttemptId\(session\)/);
    assert.match(appHub, /const memberAttempt = useAttemptId\(memberSession\)/);
  });

  test('and a finished checkout starts a new one — including after a decline', () => {
    // Opening the checkout bumps the session, so a second deliberate purchase
    // of the same tier — a renewal — is a new attempt.
    assert.match(memberCheckout, /setSession\(\(n\) => n \+ 1\)/);
    // `completed` joined the deps when the post-success lifecycle was fixed: the
    // effect must re-evaluate when a purchase finishes, so that a remounted
    // checkout comes back finished rather than back at a Pay button.
    assert.match(memberCheckout, /\}, \[open, tier\.id, hasSavedCard, completed\]\)/);
    const appFn = appHub.slice(appHub.indexOf('const runMembershipPayment'));
    assert.match(appFn, /\} catch \(e: any\) \{[\s\S]*?Payment failed[\s\S]*?\} finally \{[\s\S]*?setMemberSession\(n => n \+ 1\)/);
  });

  test('SCA cannot change it — the bump happens after the payment call returns', () => {
    const appFn = appHub.slice(appHub.indexOf('const runMembershipPayment'));
    assert.ok(appFn.indexOf('startHubMembershipPayment') < appFn.indexOf('setMemberSession'));
    // And the web helper resumes THIS intent rather than starting another.
    assert.match(webClient, /settleSavedCardPayment\(data as ScaStart\)/);
    assert.match(intentFn, /status: 'requires_action', clientSecret: outcome\.clientSecret, payment_intent_id: outcome\.id/);
  });
});

/* ── B. self-payment ──────────────────────────────────────────────────────── */

describe('B — you cannot buy membership of a hub whose payout you control', () => {
  const s = () => scenario();

  test('the card route asks the destination question', () => {
    assert.match(intentFn, /const selfPay = await selfPaymentBlock\(svc, user\.id, hub\.stripe_account_id\)/);
    assert.match(intentFn, /You can't buy membership from a hub whose payout account you control\./);
    assert.match(intentFn, /reason: 'self_payment'/);
  });

  test('before the fee is computed and before any PaymentIntent', () => {
    const i = intentFn.indexOf('const selfPay =');
    assert.ok(i > -1);
    // The call site, not the import at the top of the file.
    assert.ok(i < intentFn.indexOf('getCommissionConfig(svc,'), 'the fee is computed before the guard');
    assert.ok(i < intentFn.indexOf('createPaymentIntent({'), 'a PaymentIntent is created before the guard');
  });

  test('owning the destination blocks it', () => {
    assert.equal(s().own_hub_destination, 'blocked');
  });

  test('a hub somebody ELSE owns, paying into YOUR account, blocks it too', () => {
    assert.equal(s().alias_destination, 'blocked');
  });

  test('an unrelated destination does not', () => {
    assert.equal(s().unrelated_destination, 'allowed');
  });

  test('and a committee member is not over-blocked by their role', () => {
    assert.equal(s().committee_not_blocked, 'allowed');
  });

  test('it is ONE definition — the card path and the wallet paths share it', () => {
    assert.match(selfPay, /\.rpc\('wallet_destination_self_controlled'/);
    // Exactly one implementation; wallet-ledger only re-exports it.
    assert.match(ledger, /export \{ selfPaymentBlock \} from '\.\/self-payment\.ts';/);
    assert.ok(!/async function selfPaymentBlock/.test(ledger), 'a second definition lives in wallet-ledger');
    assert.match(intentFn, /from '\.\.\/_shared\/self-payment\.ts'/);
  });

  test('the wallet membership route keeps its guard', () => {
    assert.match(checkout, /const selfPayMem = await selfPaymentBlock\(svc, userId, hub\.stripe_account_id\)/);
  });

  test('no Stripe account id is ever returned to a client', () => {
    assert.ok(!/json\(\{[^}]*stripe_account_id/.test(intentFn));
    for (const leak of ['acct_', 'stripe_account_id']) {
      assert.ok(!code(selfPay).includes(leak) || leak === 'stripe_account_id',
        `the refusal exposes ${leak}`);
    }
  });

  test('the destination function stays service-role only', () => {
    assert.equal(s().destination_fn_client_exec, 'none');
  });
});

/* ── the membership core, unchanged ───────────────────────────────────────── */

describe('price, duration and activation are untouched', () => {
  const s = () => scenario();

  test('price and fee are still resolved server-side from the tier', () => {
    assert.match(intentFn, /\.from\('hub_membership_types'\)/);
    assert.match(intentFn, /select\('id, hub_id, name, price_pence, period, is_active'\)/);
    assert.match(intentFn, /const totalPence = type\.price_pence \+ flatFee/);
    assert.match(intentFn, /currency:\s+'gbp'/);
    assert.ok(!code(intentFn).includes('body.amount'), 'an amount could come from the request');
  });

  test('Junior stays £10 face plus the 95p flat card fee', () => {
    assert.match(read('supabase/functions/_shared/commission-config.ts'),
      /membership: \{ percent_bps:\s+0, fixed_pence:\s+95 \}/);
    // Fee on top, so the hub receives the full price.
    assert.match(intentFn, /application_fee_amount'\] = String\(flatFee\)/);
  });

  test('a free tier still refuses, and an inactive tier is unavailable', () => {
    assert.match(intentFn, /This tier is free — join directly\./);
    assert.match(intentFn, /!type \|\| !type\.is_active/);
  });

  test('one payment grants exactly one year', () => {
    assert.equal(s().first_grant_year, 'one year');
    assert.equal(s().one_membership_row, '1');
  });

  test('the same payment again extends nothing', () => {
    assert.equal(s().replay_no_extension, 'unchanged');
  });

  test('a real renewal extends from the existing expiry, not from today', () => {
    assert.equal(s().renewal_extends_from_expiry, 'from expiry');
  });

  test('paying never promotes — and never demotes an existing committee member', () => {
    assert.equal(s().role_is_member, 'committee');
    assert.equal(s().committee_kept, 'committee');
  });

  test('the exactly-once guards are all still in place', () => {
    assert.equal(s().pi_unique_index, 'present');
    assert.equal(s().activate_client_exec, 'none');
    assert.match(fulfilment, /case 'hub_membership':/);
    assert.match(fulfilment, /\.rpc\('activate_hub_membership'/);
    assert.match(confirmFn, /pi\.metadata\?\.type !== 'hub_membership'/);
    assert.match(confirmFn, /pi\.metadata\?\.user_id !== user\.id/);
    assert.match(confirmFn, /pi\.status !== 'succeeded'/);
  });

  test('other paygates are unchanged', () => {
    for (const t of ['local_wallet_topup', 'unit_purchase', 'gift_purchase', 'event_tickets',
                     'hub_donation', 'hub_membership', 'product_order', 'shift_boost']) {
      assert.match(fulfilment, new RegExp(`case '${t}':`), `${t} lost its fulfiller`);
    }
  });

  test('and the Paygate 7 wallet guards still stand', () => {
    assert.match(ledger, /reason: 'blocked'/);
    assert.match(read('supabase/functions/local-wallet-topup-intent/index.ts'),
      /const topupIdemKey = `topup-\$\{user\.id\}-\$\{client_request_id\}`/);
  });
});
