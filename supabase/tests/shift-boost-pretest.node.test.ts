/**
 * shift-boost-pretest.node.test.ts — the three defects found before the first
 * manual shift boost.
 *
 * A — THE CHECKOUT ATTEMPT HAD NO REFERENCE
 *
 * The Stripe idempotency key was `boost-<user>-<shift>`. Nothing in it said
 * WHICH attempt, and Stripe honours a key for about 24 hours. So a declined
 * card was replayed as a decline for a day: reaching for a different card could
 * not even get to the issuer. And a later, genuinely new boost of the same
 * shift could come back as the first — already succeeded — PaymentIntent, which
 * fulfilment then deduplicated away while the page said "Shift boosted!".
 *
 * The key now ends in a client_request_id, minted once per deliberate checkout
 * and held across retries and SCA. Same attempt, same intent; new attempt, new
 * intent.
 *
 * B — A CARD-PAID BOOST HAD NO WAY BACK
 *
 * `shift_boost` was missing from fulfilByType, so it was the only paygate whose
 * fulfilment depended entirely on the browser coming back. Stripe took £2.99,
 * the tab closed, and nothing on the server ever boosted the shift. Both paths
 * now call one shared fulfiller.
 *
 * B2 — AND THE CLAIM COULD OUTLIVE THE GRANT
 *
 * confirm-boost claimed the PaymentIntent, then updated the shift. A failure
 * between the two left the payment permanently claimed and the shift never
 * boosted: every retry hit the unique violation and reported success. Both
 * statements now live inside fulfil_shift_boost, so they roll back together.
 *
 * C — ELIGIBILITY WAS A UI OPINION
 *
 * Both CTAs hide unless `status === "open" && !isBoosted`, but no backend
 * looked at the shift's state at all. £2.99 could buy promotion for a cancelled
 * shift — and a push blast advertising it to every matching worker. The rule
 * now lives in SQL, judged against the database clock, and card and wallet call
 * the same function.
 *
 * SAFETY
 * Every database assertion runs inside a transaction that is never committed,
 * against synthetic rows. Nothing here touches a real shift, no Stripe object
 * is created, and no payment is made.
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

const intentFn = read('supabase/functions/create-boost-intent/index.ts');
const confirmFn = read('supabase/functions/confirm-boost/index.ts');
const fulfilment = read('supabase/functions/_shared/fulfilment.ts');
const walletFn = read('supabase/functions/wallet-checkout/index.ts');
const webhook = read('supabase/functions/stripe-webhook/index.ts');
const boostClient = web('lib/shift-boost-client.ts');
const boostModal = web('components/jobs/ShiftBoostModal.tsx');

/** Strip comments — these files describe the old defects on purpose. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

function rowsOf(out: string): Record<string, unknown>[] {
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
}
const runSql = (sql: string) => rowsOf(execFileSync('npx',
  ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }));

/**
 * Builds synthetic shifts in every state, asks the real functions about them,
 * and rolls the whole thing back. Includes a deliberately failing boost write,
 * to prove a failed grant does not leave the payment claimed.
 */
const SCENARIO = `
begin;
create temp table r(step text, outcome text);
do $$
declare
  u1 uuid; u2 uuid;
  s_open uuid; s_cancel uuid; s_filled uuid; s_done uuid; s_draft uuid;
  s_ended uuid; s_boosted uuid; s_stale uuid; s_boom uuid; s_race uuid;
  e record; f record; g record;
  pi1 text := 'pi_probe_one'; pi2 text := 'pi_probe_two'; pi3 text := 'pi_probe_three';
  u_first timestamptz; u_second timestamptz; claimed int;
begin
  select id into u1 from auth.users order by created_at limit 1;
  select id into u2 from auth.users order by created_at desc limit 1;

  -- One shift per state the rule has an opinion about.
  insert into public.shifts (title, employer_id, category, location_text, start_at, end_at, status)
    values ('probe open', u1, 'retail', 'Lerwick', now() + interval '1 day', now() + interval '2 days', 'open')
    returning id into s_open;
  insert into public.shifts (title, employer_id, category, location_text, start_at, end_at, status)
    values ('probe cancelled', u1, 'retail', 'Lerwick', now() + interval '1 day', now() + interval '2 days', 'cancelled')
    returning id into s_cancel;
  insert into public.shifts (title, employer_id, category, location_text, start_at, end_at, status)
    values ('probe filled', u1, 'retail', 'Lerwick', now() + interval '1 day', now() + interval '2 days', 'filled')
    returning id into s_filled;
  insert into public.shifts (title, employer_id, category, location_text, start_at, end_at, status)
    values ('probe completed', u1, 'retail', 'Lerwick', now() + interval '1 day', now() + interval '2 days', 'completed')
    returning id into s_done;
  insert into public.shifts (title, employer_id, category, location_text, start_at, end_at, status)
    values ('probe draft', u1, 'retail', 'Lerwick', now() + interval '1 day', now() + interval '2 days', 'draft')
    returning id into s_draft;
  insert into public.shifts (title, employer_id, category, location_text, start_at, end_at, status)
    values ('probe ended', u1, 'retail', 'Lerwick', now() - interval '2 days', now() - interval '1 day', 'open')
    returning id into s_ended;
  insert into public.shifts (title, employer_id, category, location_text, start_at, end_at, status)
    values ('probe boosted', u1, 'retail', 'Lerwick', now() + interval '1 day', now() + interval '2 days', 'open')
    returning id into s_boosted;
  insert into public.shifts (title, employer_id, category, location_text, start_at, end_at, status)
    values ('probe stale boost', u1, 'retail', 'Lerwick', now() + interval '1 day', now() + interval '2 days', 'open')
    returning id into s_stale;
  insert into public.shifts (title, employer_id, category, location_text, start_at, end_at, status)
    values ('probe boom', u1, 'retail', 'Lerwick', now() + interval '1 day', now() + interval '2 days', 'open')
    returning id into s_boom;
  insert into public.shifts (title, employer_id, category, location_text, start_at, end_at, status)
    values ('probe race', u1, 'retail', 'Lerwick', now() + interval '1 day', now() + interval '2 days', 'open')
    returning id into s_race;

  update public.shifts set boosted_until = now() + interval '10 hours' where id = s_boosted;
  update public.shifts set boosted_until = now() - interval '10 hours' where id = s_stale;

  -- ── the rule ───────────────────────────────────────────────────────────
  for e in select * from (values
      ('elig_open', s_open), ('elig_cancelled', s_cancel), ('elig_filled', s_filled),
      ('elig_completed', s_done), ('elig_draft', s_draft), ('elig_ended', s_ended),
      ('elig_already_boosted', s_boosted), ('elig_expired_boost', s_stale)
    ) as t(step, sid)
  loop
    insert into r
      select e.step, (case when x.eligible then 'eligible' else 'refused:' || x.reason end)
        from public.shift_boost_eligibility(e.sid::uuid) x;
  end loop;
  insert into r select 'elig_unknown', reason from public.shift_boost_eligibility(gen_random_uuid());

  -- ── one payment, one boost, whichever path arrives first ───────────────
  select * into f from public.fulfil_shift_boost(pi1, s_open, u1);
  u_first := f.boosted_until;
  insert into r values ('fulfil_first', case when f.granted and not f.already then 'granted' else 'unexpected' end);
  insert into r values ('fulfil_sets_24h',
    case when f.boosted_until between now() + interval '23 hours' and now() + interval '25 hours'
         then '24h' else 'wrong:' || f.boosted_until::text end);

  select * into f from public.fulfil_shift_boost(pi1, s_open, u1);
  u_second := f.boosted_until;
  insert into r values ('fulfil_replay', case when f.already and not f.granted then 'already' else 'unexpected' end);
  insert into r values ('fulfil_no_second_24h', case when u_first = u_second then 'unchanged' else 'EXTENDED' end);
  select count(*) into claimed from public.consumed_payment_intents where payment_intent_id = pi1;
  insert into r values ('fulfil_claims_once', claimed::text);

  -- ── a payment for somebody else's shift ────────────────────────────────
  select * into f from public.fulfil_shift_boost(pi2, s_race, u2);
  insert into r values ('fulfil_cross_owner', case when f.granted then 'GRANTED' else 'refused:' || f.reason end);
  insert into r select 'cross_owner_unclaimed',
    case when exists (select 1 from public.consumed_payment_intents where payment_intent_id = pi2)
         then 'CLAIMED' else 'not claimed' end;

  -- ── the grant fails: is the payment still claimable? ───────────────────
  create or replace function pg_temp.boom() returns trigger language plpgsql as $t$
  begin
    if new.title = 'probe boom' and new.boosted_until is not null then
      raise exception 'probe: simulated boost write failure';
    end if;
    return new;
  end $t$;
  create trigger probe_boom before update on public.shifts
    for each row execute function pg_temp.boom();
  begin
    select * into f from public.fulfil_shift_boost(pi3, s_boom, u1);
    insert into r values ('fulfil_failure', 'no error raised');
  exception when others then
    insert into r values ('fulfil_failure', 'raised');
  end;
  drop trigger probe_boom on public.shifts;
  insert into r select 'failed_grant_retryable',
    case when exists (select 1 from public.consumed_payment_intents where payment_intent_id = pi3)
         then 'PERMANENTLY CLAIMED' else 'claim rolled back' end;
  select * into f from public.fulfil_shift_boost(pi3, s_boom, u1);
  insert into r values ('retry_after_failure', case when f.granted then 'granted' else 'still refused' end);

  -- ── paid, then the employer cancelled it themselves ────────────────────
  update public.shifts set status = 'cancelled' where id = s_race;
  select * into g from public.fulfil_shift_boost('pi_probe_late', s_race, u1);
  insert into r values ('paid_then_ineligible',
    case when g.granted and not g.eligible then 'granted:' || g.reason else 'nothing granted' end);

  -- ── the duration and the clock are the database's ──────────────────────
  insert into r select 'duration_in_sql',
    case when pg_get_functiondef(p.oid) like '%interval ''24 hours''%' then '24h' else 'MISSING' end
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='fulfil_shift_boost';
  insert into r select 'clock_is_db',
    case when pg_get_functiondef(p.oid) like '%now()%' then 'now()' else 'NOT DB TIME' end
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='shift_boost_eligibility';

  -- ── F2 must still stand: these functions only work because it lets them ─
  insert into r select 'f2_lock_present',
    case when exists (select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
                      where c.relname='shifts' and t.tgname='lock_shift_columns' and not t.tgisinternal)
         then 'present' else 'MISSING' end;
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims', json_build_object('sub',u1,'role','authenticated')::text, true);
  update public.shifts set boosted_until = now() + interval '30 days' where id = s_draft;
  perform set_config('role','postgres',true);
  insert into r select 'f2_direct_write',
    case when (select boosted_until from public.shifts where id=s_draft) is null
         then 'preserved' else 'BYPASS' end;
end $$;
select step, outcome from r;
`;

let cached: Record<string, string> | null = null;
function scenario(): Record<string, string> {
  if (!cached) cached = Object.fromEntries(runSql(SCENARIO).map((r) => [String(r.step), String(r.outcome)]));
  return cached;
}

/* ── A. the checkout attempt now has a reference ──────────────────────────── */

describe('A — one deliberate checkout, one PaymentIntent', () => {
  test('client_request_id is required and validated before anything is charged', () => {
    assert.match(intentFn, /client_request_id !== 'string'/);
    assert.match(intentFn, /client_request_id\.length < 8 \|\| client_request_id\.length > 100/);
    // Validated ahead of the shift lookup and every Stripe call.
    assert.ok(intentFn.indexOf('client_request_id required') < intentFn.indexOf('shift_boost_eligibility'));
    // The call site, not the helper's own definition further up the file.
    assert.ok(intentFn.indexOf('client_request_id required') < intentFn.indexOf('createPaymentIntent({'));
  });

  test('the personal-card key carries the attempt', () => {
    assert.match(intentFn, /`boost-\$\{user\.id\}-\$\{shift_id\}-\$\{client_request_id\}`/);
  });

  test('the business-card key carries the attempt', () => {
    assert.match(intentFn, /`boost-biz-\$\{business_id\}-\$\{shift_id\}-\$\{client_request_id\}`/);
  });

  test('the card-form key carries it too, so a double submit is one intent', () => {
    assert.match(intentFn, /`boost-form-\$\{user\.id\}-\$\{shift_id\}-\$\{client_request_id\}`/);
  });

  test('no idempotency key is keyed on user + shift alone any more', () => {
    const keys = [...code(intentFn).matchAll(/`boost[^`]*`/g)].map((m) => m[0]);
    assert.ok(keys.length >= 3, `expected the three keys, found ${keys.length}`);
    for (const k of keys) assert.match(k, /client_request_id/, `key without an attempt reference: ${k}`);
  });

  test('the id is idempotency only — never the buyer, shift, amount or duration', () => {
    const body = intentFn.slice(intentFn.indexOf('const baseParams'), intentFn.indexOf('Mode 0'));
    assert.match(body, /amount:\s+'299'/);
    assert.match(body, /currency:\s+'gbp'/);
    assert.ok(!body.includes('client_request_id'), 'the attempt id leaks into the charge parameters');
    assert.match(intentFn, /'metadata\[employer_id\]':\s*user\.id/);
  });

  test('the web modal mints one id per boost and reuses it across retries', () => {
    assert.match(boostModal, /const attemptId = useAttemptId\(shiftId\)/);
    // Card path and wallet path both pass it.
    assert.equal((boostModal.match(/startShiftBoost\(shiftId, attemptId\(\)/g) ?? []).length, 2);
    assert.match(boostModal, /walletCheckout\(\{ type: "shift_boost", shift_id: shiftId \}, attemptId\(\)\)/);
  });

  test('the client sends it and says what it is not for', () => {
    assert.match(boostClient, /client_request_id: attemptId/);
    assert.match(boostClient, /idempotency only/i);
  });
});

/* ── B. a paid boost lands even if the browser does not come back ─────────── */

describe('B — the webhook can finish what the browser started', () => {
  test('shift_boost is in the shared fulfilment switch', () => {
    assert.match(fulfilment, /case 'shift_boost':\s+return fulfilShiftBoost\(svc, pi\)/);
  });

  test('the webhook reaches that switch for a succeeded intent', () => {
    const succeeded = webhook.slice(webhook.indexOf("case 'payment_intent.succeeded'"),
                                   webhook.indexOf("case 'payment_intent.payment_failed'"));
    assert.match(succeeded, /fulfilByType\(supabase, \{/);
  });

  test('client confirm calls the SAME fulfiller, not a copy of it', () => {
    assert.match(confirmFn, /import \{ fulfilShiftBoost \} from '\.\.\/_shared\/fulfilment\.ts'/);
    assert.match(confirmFn, /await fulfilShiftBoost\(supabase, \{/);
  });

  test('confirm-boost no longer writes the boost or the blast itself', () => {
    const c = code(confirmFn);
    assert.ok(!/\.from\('shifts'\)\s*\.update/.test(c), 'confirm-boost still writes boosted_until directly');
    assert.ok(!c.includes('sendUserPushBulk'), 'confirm-boost still owns its own notification blast');
    assert.ok(!c.includes('consumed_payment_intents'), 'confirm-boost still claims the payment itself');
  });

  test('both paths still require a genuinely succeeded payment', () => {
    assert.match(confirmFn, /pi\.status !== 'succeeded' \|\| m\.type !== 'shift_boost'/);
    assert.match(confirmFn, /m\.shift_id !== shift_id \|\| m\.employer_id !== user\.id/);
    // The intent function returns before fulfilment for every non-success.
    assert.match(intentFn, /outcome\.kind === 'requires_action'/);
    assert.match(intentFn, /outcome\.kind !== 'succeeded'/);
  });

  test('the notification blast is now shared, so it fires once from either path', () => {
    assert.match(fulfilment, /export async function notifyMatchingWorkers/);
    assert.match(fulfilment, /\.neq\('user_id', employerId\)/);
    assert.match(fulfilment, /categoryId: 'shifts\.new_match'/);
  });

  test('a failed notification cannot undo a paid boost', () => {
    const f = fulfilment.slice(fulfilment.indexOf('export async function fulfilShiftBoost'));
    assert.match(f, /try \{\s*\n\s*notified = await notifyMatchingWorkers/);
  });
});

/* ── SCA is untouched ─────────────────────────────────────────────────────── */

describe('F — the saved-card SCA flow is unchanged', () => {
  test('an issuer challenge resumes THIS intent and starts no second one', () => {
    assert.match(intentFn, /status: 'requires_action', clientSecret: outcome\.clientSecret, payment_intent_id: outcome\.id/);
    assert.match(boostClient, /settleSavedCardPayment\(data as ScaStart\)/);
    assert.ok(!/handleNextAction[\s\S]{0,400}startShiftBoost/.test(boostClient),
      'a second intent is started after the challenge');
  });

  test('the attempt id is stable through the challenge — it is not re-minted', () => {
    // useAttemptId holds the id in a ref keyed on the shift; only unmounting or
    // a different shift discards it, and SCA does neither.
    const hook = web('lib/use-attempt-id.ts');
    assert.match(hook, /const ref = useRef<string \| null>\(null\)/);
    assert.match(hook, /if \(!ref\.current\) ref\.current = newCheckoutAttemptId\(\)/);
    assert.match(boostModal, /useAttemptId\(shiftId\)/);
  });

  test('on-session confirm parameters are untouched', () => {
    assert.match(intentFn, /\.\.\.onSessionConfirm\(customerId, pmId\)/);
    assert.match(intentFn, /\.\.\.onSessionConfirm\(biz\.business_stripe_customer_id, bizPm\)/);
  });
});

/* ── C. eligibility is a backend rule ─────────────────────────────────────── */

describe('C — a shift must be boostable before it can be sold a boost', () => {
  const s = () => scenario();

  test('an open, future, unboosted shift is eligible', () => {
    assert.equal(s().elig_open, 'eligible');
  });

  test('cancelled, filled, completed and draft are refused, each saying why', () => {
    assert.equal(s().elig_cancelled, 'refused:cancelled');
    assert.equal(s().elig_filled, 'refused:filled');
    assert.equal(s().elig_completed, 'refused:completed');
    assert.equal(s().elig_draft, 'refused:draft');
  });

  test('a shift whose work time has passed is refused', () => {
    assert.equal(s().elig_ended, 'refused:ended');
  });

  test('a live boost blocks a second one — one at a time, as the product intends', () => {
    assert.equal(s().elig_already_boosted, 'refused:already_boosted');
  });

  test('once the boost expires the shift can be boosted again', () => {
    assert.equal(s().elig_expired_boost, 'eligible');
  });

  test('an unknown shift is not found rather than quietly eligible', () => {
    assert.equal(s().elig_unknown, 'shift_not_found');
  });

  test('the rule is judged against the database clock, not the caller', () => {
    assert.equal(s().clock_is_db, 'now()');
  });

  test('the card path asks that function and refuses with its reason', () => {
    assert.match(intentFn, /\.rpc\('shift_boost_eligibility', \{ p_shift: shift_id \}\)/);
    assert.match(intentFn, /if \(!shift\.eligible\)/);
    assert.match(intentFn, /status: 409/);
  });

  test('the wallet path asks the SAME function, so the two cannot disagree', () => {
    assert.match(walletFn, /\.rpc\('shift_boost_eligibility', \{ p_shift: shiftId \}\)/);
    assert.match(walletFn, /if \(!shift\.eligible\) return json\(\{ error: BOOST_INELIGIBLE/);
  });

  test('the eligibility gate runs before any money moves', () => {
    const wb = walletFn.slice(walletFn.indexOf('async function shiftBoost'));
    assert.ok(wb.indexOf('shift.eligible') < wb.indexOf('debitAndTransfer'),
      'the wallet is debited before eligibility is checked');
    assert.ok(intentFn.indexOf('if (!shift.eligible)') < intentFn.indexOf('createPaymentIntent({'),
      'a PaymentIntent is created before eligibility is checked');
  });

  test('wallet accounting was not touched', () => {
    assert.match(walletFn, /idempotencyKey: `wallet-attempt:\$\{rid\}`/);
    assert.match(walletFn, /platformFeePence: PRICE/);
    assert.match(walletFn, /await walletReverse\(svc, paid\.transactionId, 'Shift boost could not be applied'\)/);
  });
});

/* ── one payment, one boost ───────────────────────────────────────────────── */

describe('G — the same payment cannot buy two boosts', () => {
  const s = () => scenario();

  test('the first call grants it', () => {
    assert.equal(s().fulfil_first, 'granted');
  });

  test('and grants exactly 24 hours', () => {
    assert.equal(s().fulfil_sets_24h, '24h');
    assert.equal(s().duration_in_sql, '24h');
  });

  test('the second call — webhook or client confirm, either order — finds it done', () => {
    assert.equal(s().fulfil_replay, 'already');
  });

  test('and does NOT add another 24 hours', () => {
    assert.equal(s().fulfil_no_second_24h, 'unchanged');
  });

  test('the payment is claimed exactly once', () => {
    assert.equal(s().fulfil_claims_once, '1');
  });
});

/* ── B2. a failed grant must not block the retry ──────────────────────────── */

describe('B2 — a payment is only claimed if the boost actually happened', () => {
  const s = () => scenario();

  test('a failing boost write raises rather than reporting success', () => {
    assert.equal(s().fulfil_failure, 'raised');
  });

  test('and takes the claim down with it, so the payment is still fulfillable', () => {
    assert.equal(s().failed_grant_retryable, 'claim rolled back');
  });

  test('the very next attempt grants the boost', () => {
    assert.equal(s().retry_after_failure, 'granted');
  });
});

/* ── ownership ────────────────────────────────────────────────────────────── */

describe('D — nobody boosts a shift that is not theirs', () => {
  const s = () => scenario();

  test('fulfilment refuses a payment whose employer does not own the shift', () => {
    assert.equal(s().fulfil_cross_owner, 'refused:not_owner');
  });

  test('and refuses without consuming the payment', () => {
    assert.equal(s().cross_owner_unclaimed, 'not claimed');
  });

  test('all three entry points check ownership themselves', () => {
    assert.match(intentFn, /shift\.employer_id !== user\.id/);
    assert.match(confirmFn, /owned\.employer_id !== user\.id/);
    assert.match(walletFn, /shift\.employer_id !== userId/);
  });
});

/* ── the shift changed after the money was taken ──────────────────────────── */

describe('C3 — charged and granted nothing is the one outcome we refuse', () => {
  test('a shift cancelled between payment and fulfilment is still boosted, and said so', () => {
    assert.equal(scenario().paid_then_ineligible, 'granted:boosted_ineligible');
  });

  test('fulfilment reports eligibility rather than enforcing it', () => {
    const f = fulfilment.slice(fulfilment.indexOf('export async function fulfilShiftBoost'));
    assert.ok(!/if \(!data\.eligible\) return/.test(f), 'fulfilment refuses a shift the customer already paid for');
  });
});

/* ── nothing else moved ───────────────────────────────────────────────────── */

describe('E / L — price, duration and the other paygates are untouched', () => {
  test('£2.99 in GBP, still decided by the server', () => {
    assert.match(intentFn, /amount:\s+'299'/);
    assert.match(intentFn, /currency:\s+'gbp'/);
    assert.match(walletFn, /const PRICE = 299/);
    // The modal shows the price; what matters is that it never SENDS one.
    const sent = code(boostClient).slice(code(boostClient).indexOf('body: {'));
    assert.ok(!/amount/i.test(sent.slice(0, sent.indexOf('}'))), 'the client sends an amount');
    assert.match(boostModal, /const PRICE_PENCE = 299/);
  });

  test('the F2 lock still stands, and still refuses a direct write', () => {
    assert.equal(scenario().f2_lock_present, 'present');
    assert.equal(scenario().f2_direct_write, 'preserved');
  });

  test('every other fulfilment type is unchanged', () => {
    for (const t of ['local_wallet_topup', 'unit_purchase', 'gift_purchase',
                     'event_tickets', 'hub_donation', 'hub_membership', 'product_order']) {
      assert.match(fulfilment, new RegExp(`case '${t}':`), `${t} lost its fulfiller`);
    }
  });

  test('shift boost purchase history is still absent — tracked, not silently invented', () => {
    assert.ok(!/shift_boost_purchases/.test(fulfilment + confirmFn + intentFn));
  });
});
