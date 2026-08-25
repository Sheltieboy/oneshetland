/**
 * shift-boost-purchase-history.node.test.ts — a boost leaves a receipt.
 *
 * WHAT WAS MISSING
 *
 * A card-paid shift boost left nothing a buyer could look at. Stripe had a row,
 * outside the product. consumed_payment_intents had a PaymentIntent id, a
 * purpose and a user — an internal replay guard with no shift, no amount and no
 * title, so nothing to render. shifts.boosted_until had the entitlement, and
 * twenty-four hours later that was gone too.
 *
 * A wallet-paid boost at least produced a wallet transaction. So the same £2.99
 * was durable or not depending on how it had been paid for, which is not a
 * difference a customer should be able to feel.
 *
 * WHY A TABLE
 *
 * The cheaper answers were tried on paper first and all fail on the evidence: a
 * read-time UNION in the shape of get_business_transactions has no source row to
 * read for a card boost; joining shifts for the title makes old receipts rewrite
 * themselves when the shift is edited and vanish when it is deleted;
 * local_wallet_transactions is the wallet BALANCE ledger and a card payment
 * never touched the balance; local_boost_purchases is Local business Pro, a
 * different product that happens to share a word.
 *
 * WHAT IS ASSERTED
 *   · one payment writes exactly one receipt, whichever path arrives
 *   · the receipt is written inside the transaction that grants the boost
 *   · it is a snapshot, so editing or deleting the shift does not change it
 *   · it outlives the boost, the cancellation and the listing
 *   · the purchaser reads it and nobody else does
 *   · no Stripe identifier reaches any UI query
 *   · the app can show it and still cannot sell one
 *
 * SAFETY
 * Database assertions run in a transaction that is never committed, against
 * synthetic rows. No Stripe object is created and no payment is made. The one
 * real purchase is read, never written.
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

const migration = read('supabase/migrations/20260825190000_shift_boost_purchase_history.sql');
const walletFn = read('supabase/functions/wallet-checkout/index.ts');
const fulfilment = read('supabase/functions/_shared/fulfilment.ts');
const historyPage = web('app/shifts/boosts/page.tsx');
const dataServer = web('lib/jobs-data.server.ts');
const appApi = read('lib/shifts-api.ts');
const appScreen = read('app/shift-boost-history.tsx');
const appPosted = read('app/my-posted-shifts.tsx');

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
  u1 uuid; u2 uuid; sid uuid; sid2 uuid; sid3 uuid; biz uuid;
  f record; g record;
  pi1 text := 'pi_hist_one'; rid1 text := 'rid_hist_one';
  n int; t text; until1 timestamptz; until2 timestamptz;
begin
  select id into u1 from auth.users order by created_at limit 1;
  select id into u2 from auth.users order by created_at desc limit 1;

  insert into public.local_businesses (owner_id, name, category, address, is_active)
    values (u1, 'PROBE Biz', 'other', 'Probe', true) returning id into biz;
  insert into public.shifts (title, employer_id, category, location_text, start_at, end_at, status, posted_as_business_id)
    values ('probe card shift', u1, 'retail', 'Lerwick', now() + interval '1 day', now() + interval '2 days', 'open', biz)
    returning id into sid;
  insert into public.shifts (title, employer_id, category, location_text, start_at, end_at, status)
    values ('probe wallet shift', u1, 'retail', 'Lerwick', now() + interval '1 day', now() + interval '2 days', 'open')
    returning id into sid2;
  insert into public.shifts (title, employer_id, category, location_text, start_at, end_at, status)
    values ('probe lifecycle shift', u1, 'retail', 'Lerwick', now() + interval '1 day', now() + interval '2 days', 'open')
    returning id into sid3;

  -- ── card: webhook, then client confirm, then a webhook retry ───────────
  select * into f from public.fulfil_shift_boost(pi1, sid, u1);
  until1 := f.boosted_until;
  perform public.fulfil_shift_boost(pi1, sid, u1);
  perform public.fulfil_shift_boost(pi1, sid, u1);
  select count(*) into n from public.shift_boost_purchases where payment_intent_id = pi1;
  insert into r values ('card_rows_for_one_pi', n::text);

  select count(*) into n from public.shift_boost_purchases
    where payment_intent_id = pi1 and amount_pence = 299 and duration_hours = 24
      and method = 'card' and status = 'completed' and employer_id = u1;
  insert into r values ('card_row_contents', case when n = 1 then 'correct' else 'WRONG' end);

  insert into r select 'card_business_snapshot',
    case when business_name = 'PROBE Biz' and business_id = biz then 'kept' else 'MISSING' end
    from public.shift_boost_purchases where payment_intent_id = pi1;

  insert into r select 'card_boosted_until_matches',
    case when boosted_until = until1 then 'matches' else 'DIFFERS' end
    from public.shift_boost_purchases where payment_intent_id = pi1;

  -- ── the receipt is a snapshot ──────────────────────────────────────────
  update public.shifts set title = 'RENAMED' where id = sid;
  insert into r select 'snapshot_survives_edit',
    case when shift_title = 'probe card shift' then 'unchanged' else 'REWRITTEN' end
    from public.shift_boost_purchases where payment_intent_id = pi1;

  -- ── and outlives the listing ───────────────────────────────────────────
  update public.shifts set status = 'cancelled', boosted_until = now() - interval '1 hour' where id = sid;
  select count(*) into n from public.shift_boost_purchases where payment_intent_id = pi1;
  insert into r values ('survives_cancel_and_expiry', n::text);

  delete from public.shifts where id = sid;
  select count(*) into n from public.shift_boost_purchases where payment_intent_id = pi1;
  insert into r values ('survives_shift_delete', n::text);
  insert into r select 'delete_nulls_link_keeps_title',
    case when shift_id is null and shift_title = 'probe card shift' then 'ok' else 'BROKEN' end
    from public.shift_boost_purchases where payment_intent_id = pi1;

  -- ── wallet: same receipt, idempotent on the attempt ─────────────────────
  select * into g from public.grant_wallet_shift_boost(sid2, u1, rid1, 299);
  until2 := g.boosted_until;
  select * into g from public.grant_wallet_shift_boost(sid2, u1, rid1, 299);
  select count(*) into n from public.shift_boost_purchases where wallet_request_id = rid1;
  insert into r values ('wallet_rows_for_one_attempt', n::text);
  insert into r values ('wallet_retry_no_new_24h', case when g.boosted_until = until2 and g.already then 'same' else 'EXTENDED' end);
  select count(*) into n from public.shift_boost_purchases
    where wallet_request_id = rid1 and amount_pence = 299 and duration_hours = 24 and method = 'wallet';
  insert into r values ('wallet_row_contents', case when n = 1 then 'correct' else 'WRONG' end);

  -- ── a failed grant leaves no receipt and no claim ───────────────────────
  create or replace function pg_temp.boom() returns trigger language plpgsql as $t$
  begin
    if new.title = 'probe lifecycle shift' and new.boosted_until is not null then
      raise exception 'probe: simulated failure';
    end if;
    return new;
  end $t$;
  create trigger probe_boom before update on public.shifts
    for each row execute function pg_temp.boom();
  begin
    perform public.fulfil_shift_boost('pi_hist_boom', sid3, u1);
  exception when others then null; end;
  drop trigger probe_boom on public.shifts;
  select count(*) into n from public.shift_boost_purchases where payment_intent_id = 'pi_hist_boom';
  insert into r values ('failed_grant_no_receipt', n::text);
  select count(*) into n from public.consumed_payment_intents where payment_intent_id = 'pi_hist_boom';
  insert into r values ('failed_grant_no_claim', n::text);

  -- ── ownership ──────────────────────────────────────────────────────────
  -- Counted while acting AS each role, but recorded afterwards: the temp table
  -- belongs to postgres, and writing to it as the authenticated role is refused.
  declare v_own int; v_stranger int; v_anon int; v_insert text; v_anon_result text;
  begin
    perform set_config('role','authenticated',true);
    perform set_config('request.jwt.claims', json_build_object('sub',u1,'role','authenticated')::text, true);
    select count(*) into v_own from public.shift_boost_purchases;

    perform set_config('request.jwt.claims', json_build_object('sub',u2,'role','authenticated')::text, true);
    select count(*) into v_stranger from public.shift_boost_purchases where employer_id = u1;

    -- Owning the business named on the receipt is not owning the receipt.
    begin
      insert into public.shift_boost_purchases
        (employer_id, shift_id, shift_title, amount_pence, duration_hours, method, payment_intent_id, boosted_until)
        values (u2, sid2, 'forged', 299, 24, 'card', 'pi_forged', now());
      v_insert := 'ALLOWED';
    exception when others then v_insert := 'refused'; end;

    -- Signed out is refused outright: anon carries no SELECT grant, so it does
    -- not even reach the policy. A 42501 is a better answer than zero rows.
    perform set_config('role','anon',true);
    perform set_config('request.jwt.claims', null, true);
    begin
      select count(*) into v_anon from public.shift_boost_purchases;
      v_anon_result := 'read:' || v_anon::text;
    exception when insufficient_privilege then v_anon_result := 'refused';
              when others then v_anon_result := 'refused'; end;

    perform set_config('role','postgres',true);
    insert into r values ('purchaser_sees_own', case when v_own >= 2 then 'yes' else 'no:' || v_own::text end);
    insert into r values ('stranger_sees_none', v_stranger::text);
    insert into r values ('client_insert', v_insert);
    insert into r values ('anon_sees', v_anon_result);
  end;
end $$;
select step, outcome from r;
`;

let cached: Record<string, string> | null = null;
function scenario(): Record<string, string> {
  if (!cached) cached = Object.fromEntries(runSql(SCENARIO).map((r) => [String(r.step), String(r.outcome)]));
  return cached;
}

/* ── the receipt exists, once ─────────────────────────────────────────────── */

describe('a successful card boost writes exactly one durable receipt', () => {
  const s = () => scenario();

  test('webhook, client confirm and a webhook retry produce ONE row', () => {
    assert.equal(s().card_rows_for_one_pi, '1');
  });

  test('with the authoritative amount, duration, method and purchaser', () => {
    assert.equal(s().card_row_contents, 'correct');
  });

  test('and the boost it granted', () => {
    assert.equal(s().card_boosted_until_matches, 'matches');
  });

  test('business context is snapshotted when the shift was posted as one', () => {
    assert.equal(s().card_business_snapshot, 'kept');
  });

  test('the receipt is written inside the same transaction as the grant', () => {
    const fn = migration.slice(migration.indexOf('create or replace function public.fulfil_shift_boost'),
                               migration.indexOf('comment on function public.fulfil_shift_boost'));
    // claim, boost, receipt — one plpgsql body, therefore one transaction.
    assert.ok(fn.indexOf('insert into public.consumed_payment_intents') <
              fn.indexOf('update public.shifts'));
    assert.ok(fn.indexOf('update public.shifts') <
              fn.indexOf('insert into public.shift_boost_purchases'));
  });

  test('the shared fulfiller is still the only caller, so the webhook path gets it too', () => {
    assert.match(fulfilment, /case 'shift_boost':\s+return fulfilShiftBoost\(svc, pi\)/);
    assert.match(fulfilment, /\.rpc\('fulfil_shift_boost', \{ p_pi: pi\.id, p_shift: shiftId, p_employer: employerId \}\)/);
  });
});

/* ── a receipt does not rewrite itself ────────────────────────────────────── */

describe('the receipt is a snapshot, not a view of the shift', () => {
  const s = () => scenario();

  test('editing the shift title does not change what was bought', () => {
    assert.equal(s().snapshot_survives_edit, 'unchanged');
  });

  test('cancelling the shift and expiring the boost leave it standing', () => {
    assert.equal(s().survives_cancel_and_expiry, '1');
  });

  test('deleting the shift leaves it standing', () => {
    assert.equal(s().survives_shift_delete, '1');
  });

  test('the link is nulled and the title kept, rather than the row cascading away', () => {
    assert.equal(s().delete_nulls_link_keeps_title, 'ok');
    assert.match(migration, /shift_id\s+uuid\s+references public\.shifts\(id\) on delete set null/);
  });
});

/* ── wallet parity ────────────────────────────────────────────────────────── */

describe('a wallet boost gets the same receipt', () => {
  const s = () => scenario();

  test('one completed attempt, one row', () => {
    assert.equal(s().wallet_rows_for_one_attempt, '1');
  });

  test('a retried attempt buys no second 24 hours', () => {
    assert.equal(s().wallet_retry_no_new_24h, 'same');
  });

  test('with the same fields the card receipt carries', () => {
    assert.equal(s().wallet_row_contents, 'correct');
  });

  test('the wallet debit and its reversal are untouched', () => {
    const wb = walletFn.slice(walletFn.indexOf('async function shiftBoost'));
    assert.match(wb, /idempotencyKey: `wallet-attempt:\$\{rid\}`/);
    assert.match(wb, /platformFeePence: PRICE/);
    assert.match(wb, /await walletReverse\(svc, paid\.transactionId, 'Shift boost could not be applied'\)/);
    assert.match(wb, /await settleAttempt\(svc, rid, 'reversed', paid\.transactionId\)/);
  });

  test('the wallet no longer writes boosted_until on its own', () => {
    const wb = code(walletFn.slice(walletFn.indexOf('async function shiftBoost')));
    assert.ok(!/from\('shifts'\)\s*\.update/.test(wb), 'the wallet still updates the shift directly');
    assert.match(wb, /\.rpc\('grant_wallet_shift_boost'/);
  });

  test('the existing wallet transaction is not duplicated into a second money movement', () => {
    // The receipt is history, not a balance movement: it never touches the
    // wallet ledger, so nothing is double-counted. (The migration's header
    // explains why it does not, hence stripping comments before looking.)
    assert.ok(!code(migration).includes('local_wallet_transactions'));
  });
});

/* ── failure leaves nothing half-done ─────────────────────────────────────── */

describe('a failed grant leaves no receipt and no claim', () => {
  test('no receipt is written', () => {
    assert.equal(scenario().failed_grant_no_receipt, '0');
  });

  test('and the payment is still fulfillable', () => {
    assert.equal(scenario().failed_grant_no_claim, '0');
  });
});

/* ── who may read it ──────────────────────────────────────────────────────── */

describe('history is purchaser-scoped', () => {
  const s = () => scenario();

  test('the purchaser reads their own', () => {
    assert.equal(s().purchaser_sees_own, 'yes');
  });

  test('another signed-in account reads none of them', () => {
    assert.equal(s().stranger_sees_none, '0');
  });

  test('signed out is refused the table entirely', () => {
    assert.equal(s().anon_sees, 'refused');
  });

  test('and no client can write one', () => {
    assert.equal(s().client_insert, 'refused');
    assert.match(migration, /for select\s*\n\s*using \(employer_id = auth\.uid\(\)\)/);
    assert.match(migration, /grant select on public\.shift_boost_purchases to authenticated/);
  });

  test('owning the business on the receipt grants nothing', () => {
    const policies = migration.match(/create policy[\s\S]*?;/g) ?? [];
    assert.equal(policies.length, 1);
    assert.ok(!policies[0].includes('local_businesses'), 'business ownership is a route into the policy');
  });
});

/* ── nothing private reaches a screen ─────────────────────────────────────── */

describe('no Stripe identifier is exposed', () => {
  test('the web query names its columns and payment_intent_id is not among them', () => {
    const fn = dataServer.match(/export async function getMyBoostPurchases[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(fn.length > 0);
    assert.match(fn, /\.select\(/);
    assert.ok(!fn.includes('payment_intent_id'));
    assert.ok(!fn.includes('select("*")'));
  });

  test('the app query is the same shape', () => {
    // Comments stripped: the function documents WHY it omits the id.
    const fn = code(appApi.slice(appApi.indexOf('export async function fetchMyBoostPurchases')));
    assert.ok(!fn.includes('payment_intent_id'));
    assert.ok(!fn.includes("select('*')"));
    assert.match(fn, /\.select\('id, shift_id, shift_title/);
  });

  test('neither screen renders one', () => {
    for (const [name, src] of [['web', historyPage], ['app', appScreen]] as const) {
      for (const w of ['payment_intent', 'stripe_customer', 'client_secret', 'fingerprint']) {
        assert.ok(!code(src).includes(w), `${name} renders ${w}`);
      }
    }
  });
});

/* ── what the screens say ─────────────────────────────────────────────────── */

describe('the history screens', () => {
  test('web shows title, amount, duration, method, date and completion', () => {
    for (const bit of ['p.shift_title', 'gbp(p.amount_pence)', 'p.duration_hours',
                       'METHOD_LABEL[p.method]', 'fmtDate(p.purchased_at)', 'Completed']) {
      assert.ok(historyPage.includes(bit), `web history is missing ${bit}`);
    }
    assert.match(historyPage, /card: "Paid by card"/);
    assert.match(historyPage, /wallet: "Paid from wallet"/);
  });

  test('and marks a boost that is still running, without replacing the receipt', () => {
    assert.match(historyPage, /const active = p\.boosted_until > now/);
    assert.match(historyPage, /Boost currently active/);
    // The list is not filtered by activity — expired purchases still render.
    assert.ok(!/filter\([^)]*boosted_until/.test(historyPage), 'expired purchases are filtered out');
  });

  test('the app screen says the same things', () => {
    for (const bit of ['p.shift_title', 'formatPence(p.amount_pence)', 'p.duration_hours',
                       'METHOD_LABEL[p.method]', 'fmtDate(p.purchased_at)', 'Completed']) {
      assert.ok(appScreen.includes(bit), `app history is missing ${bit}`);
    }
  });

  test('it is reachable', () => {
    assert.match(web('app/shifts/manage/page.tsx'), /href="\/shifts\/boosts"/);
    assert.match(web('app/work/page.tsx'), /href: "\/shifts\/boosts", title: "Boost history"/);
    assert.match(appPosted, /router\.push\('\/shift-boost-history'\)/);
    assert.match(read('app/_layout.tsx'), /<Stack\.Screen\s+name="shift-boost-history"/);
  });
});

/* ── the app still cannot sell one ────────────────────────────────────────── */

describe('showing history is not selling', () => {
  test('the app history screen has no payment path', () => {
    const src = code(appScreen + appApi.slice(appApi.indexOf('BoostPurchase')));
    for (const banned of ['create-boost-intent', 'confirm-boost', 'ShiftBoostModal',
                          'PaymentSheet', 'client_request_id', 'Buy', '£2.99']) {
      assert.ok(!src.includes(banned), `the app history screen reintroduced ${banned}`);
    }
  });

  test('and the rest of the app still has none either', () => {
    const app = code(appPosted + read('app/shift-detail.tsx') + read('app/(tabs)/jobs.tsx'));
    for (const banned of ['create-boost-intent', 'confirm-boost', 'ShiftBoostModal']) {
      assert.ok(!app.includes(banned), `the app reintroduced ${banned}`);
    }
  });

  test('the active Boosted state is untouched — it answers a different question', () => {
    assert.match(read('components/ShiftCard.tsx'), /const featured = shift\.boosted_until != null && new Date\(shift\.boosted_until\) > new Date\(\)/);
    assert.match(web('components/jobs/ShiftOwnerHub.tsx'), /boostTimeLeft\(s\.boosted_until\)/);
    assert.match(web('components/jobs/JobsUI.tsx'), /⚡ Boosted/);
  });
});

/* ── price, duration and the real purchase ────────────────────────────────── */

describe('the authoritative facts, and the one real payment', () => {
  test('£2.99 and 24 hours are still decided by the server', () => {
    assert.match(read('supabase/functions/create-boost-intent/index.ts'), /amount:\s+'299'/);
    assert.match(migration, /v_amount integer := 299/);
    assert.match(migration, /interval '24 hours'/);
    assert.match(walletFn, /const PRICE = 299/);
  });

  test('the real Cafe worker purchase is represented, and needed no second payment', () => {
    const r = runSql(`
      select (select count(*)::text from public.shift_boost_purchases)                          as receipts,
             (select count(*)::text from public.consumed_payment_intents where purpose='shift_boost') as claims,
             (select count(*)::text
                from public.shift_boost_purchases p
                join public.consumed_payment_intents c on c.payment_intent_id = p.payment_intent_id
               where c.purpose = 'shift_boost'
                 and p.employer_id = c.user_id
                 and p.purchased_at = c.consumed_at
                 and p.boosted_until = c.consumed_at + interval '24 hours'
                 and p.amount_pence = 299 and p.duration_hours = 24 and p.method = 'card')      as reconciled;`)[0];
    // Every card receipt must reconcile to a real claimed PaymentIntent.
    assert.equal(r.receipts, r.reconciled,
      `${r.receipts} receipts but only ${r.reconciled} reconcile to a claimed payment`);
    assert.equal(r.claims, r.reconciled, 'a claimed shift-boost payment has no receipt');
  });
});
