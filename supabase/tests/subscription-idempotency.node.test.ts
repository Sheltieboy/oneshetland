/**
 * subscription-idempotency.node.test.ts — one checkout, one subscription.
 *
 * local-subscription-intent created a recurring subscription and, with a saved
 * card, confirmed the first payment in the same request. It carried no attempt
 * reference and no Stripe idempotency key, and its only guard read
 * local_businesses.stripe_subscription_id — written asynchronously by the
 * WEBHOOK, so during the seconds a double-click spans it is still null.
 *
 * Two clicks therefore bought two subscriptions, each charging its own first
 * invoice and each renewing every month. A browser timeout was worse: the work
 * had succeeded, the customer saw nothing, and clicking again bought it twice.
 *
 * SAFETY
 * Nothing here talks to Stripe. The registry is exercised against the real
 * database inside transactions that are ROLLED BACK, and the function is read
 * as source. No subscription is created and no card is charged.
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
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

const fn = code(read('supabase/functions/local-subscription-intent/index.ts'));
const billing = code(web('components/business/BillingManager.tsx'));
const client = code(web('lib/business-client.ts'));

function rowsOf(out: string): Record<string, unknown>[] {
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
}
const runSql = (sql: string) => rowsOf(execFileSync('npx',
  ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }));

/** A rolled-back scenario over the real registry. */
function scenario(body: string): Record<string, string> {
  const rows = runSql(`begin;
create temp table res (n serial, scen text, got text);
create or replace function pg_temp.mkbiz(p_owner uuid) returns uuid language plpgsql as $f$
declare v uuid := gen_random_uuid();
begin insert into public.local_businesses (id,name,category,address,owner_id,subscription_tier)
      values (v,'ZZ Sub Fixture','other','Lerwick',p_owner,'free'); return v; end $f$;
create or replace function pg_temp.claim(p_rid text, p_user uuid, p_biz uuid, p_tier text, p_period text)
returns text language plpgsql as $f$
declare r record; begin
  select * into r from public.claim_subscription_attempt(
    p_rid, p_user, p_biz, p_tier, p_period,
    p_user::text||':'||p_biz::text||':'||p_tier||':'||p_period);
  return r.outcome || '/' || coalesce(r.stripe_subscription_id,'-');
end $f$;
do $$
declare o uuid; o2 uuid; b uuid; b2 uuid;
begin
  select id into o from public.profiles limit 1;
  select id into o2 from public.profiles offset 1 limit 1;
${body}
end $$;
select scen, got from res order by n;
rollback;`);
  const out: Record<string, string> = {};
  for (const r of rows) out[String(r.scen)] = `${r.got}`;
  return out;
}
const rec = (name: string, expr: string) => `  insert into res(scen,got) values ('${name}', ${expr});\n`;

/* ── 1. the registry itself ───────────────────────────────────────────────── */

describe('one deliberate checkout claims once', () => {
  const r = scenario(`
  b := pg_temp.mkbiz(o);
${rec('first', "pg_temp.claim('attempt-aaaaaaaa', o, b, 'pro', 'monthly')")}
${rec('retry_before_stripe', "pg_temp.claim('attempt-aaaaaaaa', o, b, 'pro', 'monthly')")}
  perform public.settle_subscription_attempt('attempt-aaaaaaaa','in_flight','sub_zz_A');
${rec('retry_after_stripe', "pg_temp.claim('attempt-aaaaaaaa', o, b, 'pro', 'monthly')")}
  perform public.settle_subscription_attempt('attempt-aaaaaaaa','completed','sub_zz_A');
${rec('retry_after_done', "pg_temp.claim('attempt-aaaaaaaa', o, b, 'pro', 'monthly')")}
${rec('different_attempt', "pg_temp.claim('attempt-bbbbbbbb', o, b, 'pro', 'monthly')")}
${rec('same_id_other_tier', "pg_temp.claim('attempt-aaaaaaaa', o, b, 'premium', 'monthly')")}
${rec('same_id_other_period', "pg_temp.claim('attempt-aaaaaaaa', o, b, 'pro', 'annual')")}
  b2 := pg_temp.mkbiz(o);
${rec('same_id_other_business', "pg_temp.claim('attempt-aaaaaaaa', o, b2, 'pro', 'monthly')")}
${rec('same_id_other_user', "pg_temp.claim('attempt-aaaaaaaa', o2, b, 'pro', 'monthly')")}
${rec('rows_for_this_attempt', "(select count(*)::text from public.local_subscription_attempts where client_request_id='attempt-aaaaaaaa')")}`);

  test('the first call claims it', () => assert.equal(r.first, 'claimed/-'));

  test('a retry before Stripe was reached is told to wait, not given a second go', () =>
    assert.equal(r.retry_before_stripe, 'in_flight/-'));

  test('a retry AFTER Stripe was reached resumes the SAME subscription', () =>
    // The network-uncertainty case: the work succeeded, the browser never heard.
    assert.equal(r.retry_after_stripe, 'resume/sub_zz_A'));

  test('a retry after completion replays the same subscription', () =>
    assert.equal(r.retry_after_done, 'replay/sub_zz_A'));

  test('a NEW deliberate attempt is free to proceed', () =>
    assert.equal(r.different_attempt, 'claimed/-'));

  test('the same reference cannot buy a different tier', () =>
    assert.equal(r.same_id_other_tier, 'conflict/-'));
  test('…nor a different billing period', () =>
    assert.equal(r.same_id_other_period, 'conflict/-'));
  test('…nor a different business', () =>
    assert.equal(r.same_id_other_business, 'conflict/-'));
  test('…nor be used by a different person', () =>
    assert.equal(r.same_id_other_user, 'conflict/-'));

  test('one attempt is one row, however many times it is claimed', () =>
    assert.equal(r.rows_for_this_attempt, '1'));
});

/* ── 2. concurrency, decided by the primary key ───────────────────────────── */

describe('simultaneous identical requests', () => {
  test('twenty concurrent claims produce exactly one winner', () => {
    // Not sequential calls: twenty rows racing the same insert inside one
    // statement, which is what the primary key is there to decide.
    const r = runSql(`
      begin;
      insert into public.local_businesses (id,name,category,address,owner_id,subscription_tier)
      select '11111111-1111-1111-1111-111111111111', 'ZZ Race', 'other', 'Lerwick',
             (select id from public.profiles limit 1), 'free';
      create or replace function pg_temp.race(n int) returns text language plpgsql as $f$
      declare r record; u uuid; begin
        select id into u from public.profiles limit 1;
        select * into r from public.claim_subscription_attempt(
          'race-attempt-0001', u, '11111111-1111-1111-1111-111111111111', 'pro', 'monthly',
          u::text||':11111111-1111-1111-1111-111111111111:pro:monthly');
        return r.outcome;
      end $f$;
      select count(*) filter (where pg_temp.race(g) = 'claimed')::text winners,
             count(*)::text attempts
        from generate_series(1,20) g;
      rollback;`)[0];
    assert.equal(r.winners, '1', 'more than one caller was allowed to create a subscription');
    assert.equal(r.attempts, '20');
  });
});

/* ── 3. the function actually uses it ─────────────────────────────────────── */

describe('local-subscription-intent is bound to the attempt', () => {
  test('a checkout reference is required and shape-validated', () => {
    assert.match(fn, /client_request_id required/);
    assert.match(fn, /client_request_id must be 8-100 characters/);
  });

  test('the attempt is claimed BEFORE Stripe is touched', () => {
    const claimAt = fn.indexOf('claim_subscription_attempt');
    const createAt = fn.indexOf('stripe.subscriptions.create');
    assert.ok(claimAt > 0 && createAt > 0);
    assert.ok(claimAt < createAt, 'a subscription could be created before the attempt is claimed');
  });

  test('a resumed attempt returns the existing subscription instead of making one', () => {
    assert.match(fn, /resumeExisting/);
    const resumeAt = fn.indexOf('return await resumeExisting');
    assert.ok(resumeAt > 0 && resumeAt < fn.indexOf('stripe.subscriptions.create'),
      'resume must short-circuit before creation');
  });

  test('the subscription id is recorded BEFORE the first payment is confirmed', () => {
    const createAt  = fn.indexOf('stripe.subscriptions.create');
    const settleAt  = fn.indexOf("p_status: 'in_flight', p_sub_id: subscription.id");
    const confirmAt = fn.indexOf('paymentIntents.confirm');
    assert.ok(settleAt > createAt, 'the id must be recorded after Stripe returns it');
    assert.ok(settleAt < confirmAt, 'a crash mid-confirm would leave the subscription unfindable');
  });

  test('the Stripe idempotency key is deterministic and carries the attempt', () => {
    assert.match(fn, /idempotencyKey:\s*`local-sub-\$\{user\.id\}-\$\{business_id\}-\$\{tier\}-\$\{period_norm\}-\$\{client_request_id\}`/,
      'the key must be derived from the identities plus the attempt reference');
    assert.ok(!/idempotencyKey:.*(crypto|Math\.random|Date\.now)/.test(fn),
      'a freshly generated key on every invocation defeats the purpose');
  });

  test('the fingerprint binds the reference to person, business, tier and period', () =>
    assert.match(fn, /const fingerprint = `\$\{user\.id\}:\$\{business_id\}:\$\{tier\}:\$\{period_norm\}`/));

  test('refusals release the claim rather than stranding it', () => {
    // Otherwise a retry is told "already being set up" instead of the real reason.
    const already = fn.indexOf('ALREADY_SUBSCRIBED');
    assert.ok(fn.slice(0, already).includes("p_status: 'failed'"),
      'the already-subscribed refusal must settle the attempt');
  });

  test('an existing LIVE subscription is still refused', () => {
    assert.match(fn, /ALREADY_SUBSCRIBED/);
    assert.match(fn, /subscriptions\.retrieve\(business\.stripe_subscription_id\)/);
  });

  test('ownership and server-side pricing are unchanged', () => {
    assert.match(fn, /business\.owner_id !== user\.id/);
    assert.match(fn, /assertPriceMatches/);
    assert.ok(!/req\.json\(\)[\s\S]{0,400}(amount|price_id|priceId)\s*[,}]/.test(fn),
      'an amount or Price id must never be read from the request');
  });
});

/* ── 4. the browser sends one reference per deliberate choice ─────────────── */

describe('the site holds the reference across a retry', () => {
  test('the checkout call carries a client_request_id', () =>
    assert.match(client, /client_request_id: clientRequestId/));

  test('the id is held across renders, keyed by the plan chosen', () => {
    assert.match(billing, /subAttempt = useRef<\{ key: string; id: string \} \| null>/);
    assert.match(billing, /subAttemptId\(target, period\)/);
  });

  test('it is NOT minted through an effect', () => {
    // useAttemptId resets in a useEffect, which runs after the click has already
    // minted and used an id — so the retry would mint a fresh one and create a
    // second subscription, which is the whole defect.
    assert.ok(!/useAttemptId/.test(billing),
      'an effect-reset attempt id cannot survive the retry it exists to protect');
    assert.match(billing, /if \(!subAttempt\.current \|\| subAttempt\.current\.key !== key\)/);
  });
});

/* ── 5. the registry is server-only ───────────────────────────────────────── */

describe('nothing client-side can forge an attempt', () => {
  test('the table is unreachable with an anon key or a user token', () => {
    const g = runSql(`select grantee, string_agg(privilege_type,',' order by privilege_type) p
                        from information_schema.role_table_grants
                       where table_schema='public' and table_name='local_subscription_attempts'
                         and grantee in ('anon','authenticated') group by grantee;`);
    assert.equal(g.length, 0, 'a client role can reach the attempt registry');
    const rls = runSql(`select relrowsecurity::text on_ from pg_class
                         where oid='public.local_subscription_attempts'::regclass;`)[0];
    assert.equal(rls.on_, 'true', 'row level security is off');
  });

  test('the claim RPCs are service_role only and pin their search_path', () => {
    const r = runSql(`select p.proname,
                             has_function_privilege('anon', p.oid, 'EXECUTE')::text a,
                             has_function_privilege('authenticated', p.oid, 'EXECUTE')::text u,
                             has_function_privilege('service_role', p.oid, 'EXECUTE')::text s,
                             coalesce(array_to_string(p.proconfig,','),'') cfg
                        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                       where n.nspname='public'
                         and p.proname in ('claim_subscription_attempt','settle_subscription_attempt');`);
    assert.equal(r.length, 2);
    for (const f of r) {
      assert.equal(f.a, 'false', `${f.proname} is callable with the anon key`);
      assert.equal(f.u, 'false', `${f.proname} is callable by any signed-in user`);
      assert.equal(f.s, 'true');
      assert.match(String(f.cfg), /search_path=/);
    }
  });

  test('a subscription id once known is never unset', () => {
    const r = runSql(`
      begin;
      insert into public.local_businesses (id,name,category,address,owner_id,subscription_tier)
      select '22222222-2222-2222-2222-222222222222','ZZ Keep','other','Lerwick',(select id from public.profiles limit 1),'free';
      insert into public.local_subscription_attempts
        (client_request_id,user_id,business_id,tier,period,payload_fingerprint,stripe_subscription_id,status)
      select 'keep-attempt-01',(select id from public.profiles limit 1),
             '22222222-2222-2222-2222-222222222222','pro','monthly','fp','sub_keep_me','in_flight';
      select public.settle_subscription_attempt('keep-attempt-01','failed',null,null);
      select coalesce(stripe_subscription_id,'LOST') kept from public.local_subscription_attempts
       where client_request_id='keep-attempt-01';
      rollback;`)[0];
    assert.equal(r.kept, 'sub_keep_me', 'a later settle erased the id a retry needs to find');
  });
});

/* ── 6. a spent attempt does not trap the next deliberate purchase ────────── */

describe('a NEW deliberate purchase of the same plan gets its own reference', () => {
  /**
   * The retry rule and the fresh-purchase rule pull in opposite directions.
   * Holding the reference is what stops a double-click buying twice; holding it
   * FOR EVER is what stopped somebody who subscribed, cancelled and came back
   * from buying again — every later click resumed the same spent checkout.
   *
   * So the reference is released only when the server has said the attempt is
   * definitively over, never because a response failed.
   */
  test('the id is released on activation and on a terminal refusal only', () => {
    assert.match(billing, /function endSubAttempt\(\) \{ subAttempt\.current = null; \}/);
    assert.match(billing, /if \(intent\.activated\) \{ endSubAttempt\(\);/,
      'a completed purchase must not hold its reference into the next one');
    assert.match(billing, /code === 'ATTEMPT_TERMINAL' \|\| code === 'ATTEMPT_CONFLICT'/,
      'a spent attempt must be released so a fresh purchase can be made');
    assert.match(billing, /onPaid=\{\(\) => \{ endSubAttempt\(\);/,
      'paying through the card form also ends the attempt');
  });

  test('it is NOT released merely because a request failed', () => {
    // The whole protection is that a dropped response keeps the same reference.
    // Anchored on the guard itself: there are other one-line catches in this
    // file, and slicing from the first of them tested nothing.
    const guard = billing.indexOf("if (code === 'ATTEMPT_TERMINAL'");
    assert.ok(guard > 0, 'the terminal-code guard is missing');
    const block = billing.slice(billing.lastIndexOf('} catch (e) {', guard), guard);
    assert.match(block, /const code = \(e as \{ code\?: string \}\)\?\.code;/,
      'the code must be read before anything is released');
    assert.ok(!/endSubAttempt\(\)/.test(block),
      'the reference must not be released before the code has been checked');
  });

  test('the refusal code survives the client helper', () =>
    // Without this every failure looks identical and the client cannot tell a
    // spent checkout from one worth retrying.
    assert.match(client, /throw Object\.assign\(new Error\(msg\), code \? \{ code \} : \{\}\)/));

  test('a cancelled or expired subscription is retired, not resumed', () => {
    assert.match(fn, /\['canceled', 'incomplete_expired'\]\.includes\(sub\.status\)/);
    assert.match(fn, /ATTEMPT_TERMINAL/);
    const terminalAt = fn.indexOf("['canceled', 'incomplete_expired']");
    const activeAt = fn.indexOf("if (['active', 'trialing'].includes(sub.status)) {");
    assert.ok(terminalAt < activeAt, 'the dead-subscription check must come first');
  });

  test('a spent subscription can never be reported as activated', () => {
    // Its last invoice may well have been paid before it was cancelled, so
    // reading that PaymentIntent would tell somebody with no subscription that
    // they had one.
    const resume = fn.slice(fn.indexOf('async function resumeExisting'));
    const activatedLine = resume.slice(resume.indexOf('activated: true') - 200, resume.indexOf('activated: true'));
    assert.ok(!/pi\?\.status === 'succeeded'/.test(activatedLine),
      'an old succeeded invoice must not stand in for a live subscription');
  });

  test('the server retires the attempt so the fresh one is a NEW claim', () => {
    const resume = fn.slice(fn.indexOf('async function resumeExisting'));
    assert.match(resume, /settle_subscription_attempt[\s\S]{0,160}p_status: 'failed'/);
  });

  test('a terminal attempt is replayed, never silently re-run', () => {
    // Server side: the same id after a terminal outcome still resolves to the
    // same row, which is why the CLIENT has to mint a new one.
    const r = scenario(`
  b := pg_temp.mkbiz(o);
${rec('claimed', "pg_temp.claim('spent-attempt-01', o, b, 'pro', 'monthly')")}
  perform public.settle_subscription_attempt('spent-attempt-01','in_flight','sub_spent');
  perform public.settle_subscription_attempt('spent-attempt-01','failed',null,'{"reason":"canceled"}'::jsonb);
${rec('same_id_again', "pg_temp.claim('spent-attempt-01', o, b, 'pro', 'monthly')")}
${rec('fresh_id_same_plan', "pg_temp.claim('spent-attempt-02', o, b, 'pro', 'monthly')")}
${rec('rows', "(select count(*)::text from public.local_subscription_attempts where business_id = b)")}`);
    assert.equal(r.claimed, 'claimed/-');
    assert.equal(r.same_id_again, 'replay/sub_spent',
      'reusing a spent reference must resolve to the same attempt, not start a new one');
    assert.equal(r.fresh_id_same_plan, 'claimed/-',
      'a NEW reference for the same plan must be free to proceed');
    assert.equal(r.rows, '2', 'two deliberate attempts, two rows');
  });
});
