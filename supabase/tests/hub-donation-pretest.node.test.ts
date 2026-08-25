/**
 * hub-donation-pretest.node.test.ts — four things fixed before the first real
 * hub donation.
 *
 * A — THE CHECKOUT ATTEMPT HAD NO REFERENCE
 *
 * The Stripe key was `donation-<user>-<campaign>-<amount>`. Stripe honours a
 * key for ~24 hours, so a donor giving £10 twice to the same campaign in a day
 * got the FIRST PaymentIntent back; fulfilment deduplicated on it and the page
 * thanked them for a donation that never happened. A declined card could not be
 * retried at the same amount either, and the card-form route carried no key at
 * all. Every route now ends its key in a client_request_id.
 *
 * B — THE WEBHOOK LOST THE DONOR'S CHOICES
 *
 * Anonymity, message and Gift Aid existed only in the browser's confirm call.
 * fulfilHubDonation had no way to know them and recorded p_anon=false,
 * p_message=null — so a webhook that beat the browser published the real name
 * of somebody who had asked to be anonymous.
 *
 * Not fixed by putting them in Stripe metadata: Gift Aid is a full name, a home
 * address and a postcode, and that is HMRC declarant data. The server now
 * writes an authoritative pending attempt BEFORE the PaymentIntent, and the
 * intent carries only an opaque reference to it.
 *
 * C — A FINISHED CAMPAIGN STILL TOOK MONEY
 *
 * Eligibility was `status <> 'active'` and nothing else. The production demo
 * campaign ended on 8 August and was still donatable seventeen days later. The
 * rule now includes the end date, on the database clock, shared by card and
 * wallet — and is a PRE-payment gate only, so a campaign that ends during SCA
 * cannot turn a completed charge into a donation that never happened.
 *
 * D — THE FEE WAS RECORDED AS ZERO
 *
 * metadata[fee_pence] was the literal '0' while application_fee_amount was
 * 1.5% + 20p, so every card donation told the hub nothing had been retained.
 *
 * SAFETY
 * Database assertions run in a transaction that is never committed, against
 * synthetic rows. No donation is made and no Stripe object is created.
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

const intentFn = read('supabase/functions/create-hub-donation-intent/index.ts');
const confirmFn = read('supabase/functions/confirm-hub-donation/index.ts');
const fulfilment = read('supabase/functions/_shared/fulfilment.ts');
const walletFn = read('supabase/functions/wallet-checkout/index.ts');
const migration = read('supabase/migrations/20260825230000_hub_donation_attempts_and_eligibility.sql');
const webClient = web('lib/hubs-client.ts');
const webModal = web('components/hubs/DonateModal.tsx');
const webSidebar = web('components/hubs/HubSidebarActions.tsx');
const webCampaignCta = web('components/hubs/CampaignDonate.tsx');
const appApi = read('lib/hubs-api.ts');
const appDonate = read('app/hub-donate.tsx');
const appCampaign = read('app/hub-campaign.tsx');
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
  u1 uuid; u2 uuid; hub uuid;
  c_ok uuid; c_ended uuid; c_closed uuid; c_nodate uuid;
  a_anon uuid; a_named uuid; a_ga uuid;
  e record; f record;
  n int; t text;
  v_can int; v_read int;
begin
  select id into u1 from auth.users order by created_at limit 1;
  select id into u2 from auth.users order by created_at desc limit 1;
  select id into hub from public.hubs where slug = 'demo-community-trust';

  insert into public.hub_campaigns (hub_id, title, status, goal_pence, ends_at)
    values (hub, 'probe ok', 'active', 100000, now() + interval '30 days') returning id into c_ok;
  insert into public.hub_campaigns (hub_id, title, status, goal_pence, ends_at)
    values (hub, 'probe ended', 'active', 100000, now() - interval '1 day') returning id into c_ended;
  insert into public.hub_campaigns (hub_id, title, status, goal_pence, ends_at)
    values (hub, 'probe closed', 'closed', 100000, now() + interval '30 days') returning id into c_closed;
  insert into public.hub_campaigns (hub_id, title, status, goal_pence)
    values (hub, 'probe no end date', 'active', 100000) returning id into c_nodate;

  -- ── eligibility ────────────────────────────────────────────────────────
  for e in select * from (values ('elig_ok', c_ok), ('elig_ended', c_ended),
                                 ('elig_closed', c_closed), ('elig_nodate', c_nodate)) as t(step, cid)
  loop
    insert into r select e.step, case when x.eligible then 'eligible' else 'refused:' || x.reason end
      from public.campaign_donation_eligibility(e.cid::uuid) x;
  end loop;
  insert into r select 'elig_unknown', reason from public.campaign_donation_eligibility(gen_random_uuid());

  -- ── attempts ───────────────────────────────────────────────────────────
  insert into public.hub_donation_attempts
    (client_request_id, donor_user_id, campaign_id, hub_id, face_pence, cover_pence, fee_pence,
     is_anonymous, message, payment_intent_id)
    values ('rid_anon_probe', u1, c_ok, hub, 200, 0, 23, true, 'a donor message', 'pi_don_anon')
    returning id into a_anon;
  insert into public.hub_donation_attempts
    (client_request_id, donor_user_id, campaign_id, hub_id, face_pence, cover_pence, fee_pence,
     is_anonymous, message, payment_intent_id)
    values ('rid_named_probe', u1, c_ok, hub, 500, 0, 27, false, null, 'pi_don_named')
    returning id into a_named;
  insert into public.hub_donation_attempts
    (client_request_id, donor_user_id, campaign_id, hub_id, face_pence, cover_pence, fee_pence,
     gift_aid, ga_first_name, ga_last_name, ga_address, ga_postcode, payment_intent_id)
    values ('rid_ga_probe', u1, c_ok, hub, 1000, 0, 35, true, 'Ann', 'Probe', '1 Probe Rd', 'ZE1 0AA', 'pi_don_ga')
    returning id into a_ga;

  -- one reference, one attempt
  begin
    insert into public.hub_donation_attempts
      (client_request_id, donor_user_id, campaign_id, hub_id, face_pence)
      values ('rid_anon_probe', u1, c_ok, hub, 999);
    insert into r values ('rid_reuse', 'ALLOWED');
  exception when unique_violation then insert into r values ('rid_reuse', 'refused'); end;

  -- ── webhook FIRST, on an anonymous donation ────────────────────────────
  select * into f from public.fulfil_hub_donation('pi_don_anon', a_anon, null);
  insert into r values ('anon_webhook_first', case when f.recorded then 'recorded' else 'FAILED:' || f.reason end);
  insert into r select 'anon_flag_kept',
    case when is_anonymous then 'anonymous' else 'NAMED' end
    from public.hub_donations where stripe_payment_intent_id = 'pi_don_anon';
  insert into r select 'anon_message_kept',
    coalesce(message, 'LOST') from public.hub_donations where stripe_payment_intent_id = 'pi_don_anon';
  insert into r select 'anon_fee_kept',
    fee_pence::text from public.hub_donations where stripe_payment_intent_id = 'pi_don_anon';
  insert into r select 'anon_amount',
    amount_pence::text from public.hub_donations where stripe_payment_intent_id = 'pi_don_anon';

  -- the public wall must not name them
  insert into r select 'donor_wall_name', name from public.get_campaign_donors(c_ok) limit 1;

  -- the browser arriving afterwards changes nothing
  select * into f from public.fulfil_hub_donation('pi_don_anon', a_anon, u1);
  insert into r values ('confirm_after_webhook', case when f.already then 'already' else 'DOUBLE' end);
  select count(*) into n from public.hub_donations where stripe_payment_intent_id = 'pi_don_anon';
  insert into r values ('anon_rows', n::text);
  insert into r select 'campaign_credited_once', raised_pence::text || '/' || donor_count::text
    from public.hub_campaigns where id = c_ok;
  insert into r select 'attempt_consumed', status from public.hub_donation_attempts where id = a_anon;

  -- ── Gift Aid survives webhook-first fulfilment ─────────────────────────
  select * into f from public.fulfil_hub_donation('pi_don_ga', a_ga, null);
  insert into r select 'giftaid_kept',
    case when gift_aid and ga_postcode = 'ZE1 0AA' and ga_last_name = 'Probe' then 'kept' else 'LOST' end
    from public.hub_donations where stripe_payment_intent_id = 'pi_don_ga';
  -- and is never on the public wall
  select count(*) into n from public.get_campaign_donors(c_ok) w where w.name like '%Probe%';
  insert into r values ('giftaid_not_public', n::text);

  -- ── binding ────────────────────────────────────────────────────────────
  select * into f from public.fulfil_hub_donation('pi_wrong_intent', a_named, null);
  insert into r values ('pi_mismatch', case when f.recorded then 'RECORDED' else 'refused:' || f.reason end);
  select * into f from public.fulfil_hub_donation('pi_don_named', a_named, u2);
  insert into r values ('wrong_donor', case when f.recorded then 'RECORDED' else 'refused:' || f.reason end);
  select * into f from public.fulfil_hub_donation('pi_no_attempt', null, null);
  insert into r values ('no_attempt', case when f.recorded then 'RECORDED' else 'refused:' || f.reason end);

  -- ── a campaign that ends AFTER the attempt is still fulfillable ────────
  update public.hub_campaigns set ends_at = now() - interval '1 minute' where id = c_ok;
  select * into f from public.fulfil_hub_donation('pi_don_named', a_named, u1);
  insert into r values ('paid_then_expired', case when f.recorded then 'recorded' else 'REFUSED:' || f.reason end);

  -- ── grants ─────────────────────────────────────────────────────────────
  insert into r select 'attempts_client_grants',
    case when has_table_privilege('anon','public.hub_donation_attempts','select')
           or has_table_privilege('authenticated','public.hub_donation_attempts','select')
         then 'READABLE' else 'none' end;
  insert into r select 'attempts_policies', count(*)::text
    from pg_policies where schemaname='public' and tablename='hub_donation_attempts';
  insert into r select 'fulfil_fn_client_exec',
    case when has_function_privilege('anon','public.fulfil_hub_donation(text,uuid,uuid)','execute')
           or has_function_privilege('authenticated','public.fulfil_hub_donation(text,uuid,uuid)','execute')
         then 'CALLABLE' else 'none' end;
  insert into r select 'record_fn_client_exec',
    case when has_function_privilege('anon','public.record_hub_donation(uuid,uuid,uuid,integer,integer,text,boolean,text,boolean,text,text,text,text,text)','execute')
           or has_function_privilege('authenticated','public.record_hub_donation(uuid,uuid,uuid,integer,integer,text,boolean,text,boolean,text,text,text,text,text)','execute')
         then 'CALLABLE' else 'none' end;
  insert into r select 'elig_fn_client_exec',
    case when has_function_privilege('anon','public.campaign_donation_eligibility(uuid)','execute')
           or has_function_privilege('authenticated','public.campaign_donation_eligibility(uuid)','execute')
         then 'CALLABLE' else 'none' end;
  insert into r select 'search_path_pinned',
    case when (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname='public'
                 and p.proname in ('fulfil_hub_donation','campaign_donation_eligibility')
                 and p.proconfig::text like '%search_path%') = 2
         then 'both' else 'MISSING' end;
end $$;
select step, outcome from r;
`;

let cached: Record<string, string> | null = null;
function scenario(): Record<string, string> {
  if (!cached) cached = Object.fromEntries(runSql(SCENARIO).map((r) => [String(r.step), String(r.outcome)]));
  return cached;
}

/* ── A. the attempt ───────────────────────────────────────────────────────── */

describe('A — one deliberate donation, one PaymentIntent', () => {
  test('client_request_id is required and validated before Stripe', () => {
    assert.match(intentFn, /client_request_id !== 'string'/);
    assert.match(intentFn, /client_request_id\.length < 8 \|\| client_request_id\.length > 100/);
    assert.ok(intentFn.indexOf("client_request_id required") < intentFn.indexOf('createPaymentIntent({'));
  });

  test('the saved-card key carries the attempt', () => {
    assert.match(intentFn, /`donation-\$\{user\.id\}-\$\{campaign\.id\}-\$\{amount\}-\$\{client_request_id\}`/);
  });

  test('the card-form route has a key at all now, and it carries the attempt', () => {
    assert.match(intentFn, /`donation-form-\$\{user\.id\}-\$\{campaign\.id\}-\$\{amount\}-\$\{client_request_id\}`/);
  });

  test('no donation key is keyed on user + campaign + amount alone', () => {
    const keys = [...code(intentFn).matchAll(/`donation[^`]*`/g)].map((m) => m[0]);
    assert.ok(keys.length >= 2, `expected both keys, found ${keys.length}`);
    for (const k of keys) assert.match(k, /client_request_id/, `key without an attempt reference: ${k}`);
  });

  test('one reference cannot become two attempts', () => {
    assert.equal(scenario().rid_reuse, 'refused');
  });

  test('and cannot be reused for a different donation', () => {
    assert.match(intentFn, /attempt\.campaign_id !== campaign\.id \|\| attempt\.face_pence !== amount/);
    assert.match(intentFn, /That payment reference belongs to a different donation/);
  });

  test('both clients mint one id per donation and reset it on any change of mind', () => {
    assert.match(webModal, /useAttemptId\(\s*\n?\s*`\$\{campaignId\}\|\$\{amount\}\|\$\{custom\}\|\$\{coverFees\}\|\$\{anonymous\}\|\$\{message\}\|\$\{giftAid\}/);
    assert.match(appDonate, /useAttemptId\(`\$\{campaignId\}\|\$\{effectiveAmount\}\|\$\{coverFees\}\|\$\{anonymous\}\|\$\{message\}\|\$\{giftAidOn\}`\)/);
    assert.match(webClient, /client_request_id: attemptId/);
    assert.match(appApi, /client_request_id: attemptId/);
  });

  test('the id is idempotency only — it decides nothing about the money', () => {
    const body = intentFn.slice(intentFn.indexOf('const baseParams'), intentFn.indexOf('if (use_saved_card)'));
    assert.ok(!body.includes('client_request_id'), 'the attempt id leaks into the charge parameters');
    assert.match(intentFn, /donor_user_id:\s+user\.id,\s+\/\/ auth\.uid\(\), never the request body/);
  });
});

/* ── B. the donor's choices survive ───────────────────────────────────────── */

describe('B — a webhook that beats the browser records what the donor chose', () => {
  const s = () => scenario();

  test('the webhook fulfils from the attempt, not from defaults', () => {
    const f = fulfilment.slice(fulfilment.indexOf('export async function fulfilHubDonation'));
    assert.match(f, /\.rpc\('fulfil_hub_donation', \{ p_pi: pi\.id, p_attempt: pi\.metadata\.attempt_id/);
    assert.ok(!/p_anon:\s*false/.test(f), 'the webhook still hardcodes anonymity');
    assert.ok(!/p_message:\s*null/.test(f), 'the webhook still discards the message');
  });

  test('webhook-first records the donation', () => {
    assert.equal(s().anon_webhook_first, 'recorded');
  });

  test('and it stays ANONYMOUS', () => {
    assert.equal(s().anon_flag_kept, 'anonymous');
  });

  test('the public donor wall says Anonymous, not their name', () => {
    assert.equal(s().donor_wall_name, 'Anonymous');
  });

  test('the message survives', () => {
    assert.equal(s().anon_message_kept, 'a donor message');
  });

  test('Gift Aid survives, including the normalised postcode', () => {
    assert.equal(s().giftaid_kept, 'kept');
  });

  test('and Gift Aid names never reach the public wall', () => {
    assert.equal(s().giftaid_not_public, '0');
  });

  test('no declarant data travels through Stripe metadata', () => {
    // Comments stripped: the block explains what it deliberately does NOT send,
    // and naming those fields is not the same as carrying them.
    const meta = code(intentFn.slice(intentFn.indexOf('const baseParams'), intentFn.indexOf('};', intentFn.indexOf('const baseParams'))));
    for (const leak of ['postcode', 'address', 'first_name', 'last_name', 'message', 'ga_']) {
      assert.ok(!meta.includes(leak), `metadata carries ${leak}`);
    }
    assert.match(meta, /'metadata\[attempt_id\]':\s+attempt\.id/);
  });

  test('Gift Aid is validated where the attempt is written, by the shared rule', () => {
    assert.match(intentFn, /import \{ normaliseUkPostcode \} from '\.\.\/_shared\/uk-postcode\.ts'/);
    assert.match(intentFn, /charityEligible = !!hubCharity\?\.is_charity && !!hubCharity\?\.charity_number/);
    assert.match(intentFn, /doesn't look like a valid UK postcode/);
  });

  test('confirm no longer takes the donor’s choices from the request', () => {
    const c = code(confirmFn);
    assert.ok(!/anonymous = false/.test(c), 'confirm still reads anonymity from the body');
    assert.ok(!/gift_aid = null/.test(c), 'confirm still reads Gift Aid from the body');
    assert.match(confirmFn, /\.rpc\('fulfil_hub_donation'/);
  });
});

/* ── one donation, whichever order ────────────────────────────────────────── */

describe('B4 — the same payment records one donation', () => {
  const s = () => scenario();

  test('the browser arriving after the webhook finds it done', () => {
    assert.equal(s().confirm_after_webhook, 'already');
  });

  test('one row', () => {
    assert.equal(s().anon_rows, '1');
  });

  test('the campaign is credited once', () => {
    assert.equal(s().campaign_credited_once, '200/1');
  });

  test('the attempt is consumed', () => {
    assert.equal(s().attempt_consumed, 'consumed');
  });

  test('an intent that does not belong to the attempt is refused', () => {
    assert.equal(s().pi_mismatch, 'refused:attempt_pi_mismatch');
  });

  test('a donor cannot fulfil somebody else’s attempt', () => {
    assert.equal(s().wrong_donor, 'refused:not_donor');
  });

  test('a payment naming no attempt records nothing', () => {
    assert.equal(s().no_attempt, 'refused:no_attempt');
  });
});

/* ── C. eligibility ───────────────────────────────────────────────────────── */

describe('C — a finished campaign stops taking money', () => {
  const s = () => scenario();

  test('active and in date is eligible', () => {
    assert.equal(s().elig_ok, 'eligible');
  });

  test('an active campaign past its end date is refused', () => {
    assert.equal(s().elig_ended, 'refused:ended');
  });

  test('a closed campaign is refused', () => {
    assert.equal(s().elig_closed, 'refused:closed');
  });

  test('no end date means it runs until closed', () => {
    assert.equal(s().elig_nodate, 'eligible');
  });

  test('an unknown campaign is not found', () => {
    assert.equal(s().elig_unknown, 'campaign_not_found');
  });

  test('card and wallet call the same function', () => {
    assert.match(intentFn, /\.rpc\('campaign_donation_eligibility', \{ p_campaign: campaign_id \}\)/);
    assert.match(walletFn, /\.rpc\('campaign_donation_eligibility', \{ p_campaign: campaignId \}\)/);
    assert.match(migration, /c\.ends_at is null or c\.ends_at > now\(\)/);
  });

  test('the wallet refuses before it debits', () => {
    const wb = walletFn.slice(walletFn.indexOf('async function hubDonation'));
    assert.ok(wb.indexOf('elig.eligible') < wb.indexOf('debitAndTransfer'),
      'the wallet is debited before eligibility is checked');
    assert.ok(wb.indexOf('elig.eligible') < wb.indexOf('claimAttempt'));
  });

  test('both web CTAs stop inviting a donation', () => {
    assert.match(webSidebar, /disabled=\{!campaignAcceptsDonations\(campaign\)\}/);
    assert.match(webCampaignCta, /if \(closed \|\| ended\)/);
    assert.match(webCampaignCta, /This campaign has ended/);
  });

  test('both app CTAs do too', () => {
    assert.match(appCampaign, /\{campaignAcceptsDonations\(campaign\) \? \(/);
    assert.match(appHub, /\{campaignAcceptsDonations\(campaign\) \? \(/);
    assert.match(appApi, /export function campaignAcceptsDonations/);
  });
});

/* ── C2. the deadline race ────────────────────────────────────────────────── */

describe('C2 — a payment taken while eligible is still fulfilled', () => {
  test('a campaign that ends between payment and fulfilment does not lose the donation', () => {
    assert.equal(scenario().paid_then_expired, 'recorded');
  });

  test('fulfilment deliberately does not re-check eligibility', () => {
    const fn = migration.slice(migration.indexOf('create or replace function public.fulfil_hub_donation'));
    assert.ok(!fn.includes('campaign_donation_eligibility'),
      'fulfilment re-checks eligibility and can strand a paid donation');
    assert.match(fn, /Eligibility is NOT re-checked/);
  });
});

/* ── D. the fee ───────────────────────────────────────────────────────────── */

describe('D — the fee recorded is the fee retained', () => {
  test('metadata carries the real fee, not a hardcoded zero', () => {
    assert.match(intentFn, /'metadata\[fee_pence\]':\s+String\(retainedFee\)/);
    assert.ok(!/'metadata\[fee_pence\]':\s+'0'/.test(intentFn));
  });

  test('the fee is the server’s own commission calculation', () => {
    assert.match(intentFn, /const donationCfg = await getCommissionConfig\(svc, 'donation'\)/);
    assert.match(intentFn, /calculateCommission\(amount, donationCfg, 'donation'\)\.fee_pence/);
    assert.ok(!code(intentFn).includes('fee_pence: body'), 'the fee could come from the client');
  });

  test('£2 at the current default retains 23p — 1.5% + 20p', () => {
    // floor(200 * 150 / 10_000) = 3, + 20 = 23.
    assert.equal(Math.floor((200 * 150) / 10_000) + 20, 23);
    assert.match(read('supabase/functions/_shared/commission-config.ts'), /donation:\s+\{ percent_bps: 150, fixed_pence:\s+20 \}/);
    assert.equal(scenario().anon_fee_kept, '23');
  });

  test('nothing is retained when there is no destination to retain it from', () => {
    assert.match(intentFn, /const retainedFee = hubHasAccount \? feeEstimate : 0/);
  });

  test('the face amount is what the campaign is credited', () => {
    assert.equal(scenario().anon_amount, '200');
    assert.match(migration, /a\.face_pence, a\.fee_pence/);
  });

  test('cover-fee economics are unchanged', () => {
    assert.match(intentFn, /const coverPence = cover_fees \? feeEstimate : 0/);
    assert.match(intentFn, /const totalPence = amount \+ coverPence/);
    assert.match(intentFn, /amount:\s+String\(totalPence\)/);
  });

  test('wallet donations still retain nothing', () => {
    const wb = walletFn.slice(walletFn.indexOf('async function hubDonation'));
    assert.match(wb, /p_fee: 0/);
    assert.ok(!/platformFeePence/.test(wb.slice(0, wb.indexOf('record_hub_donation'))));
  });
});

/* ── security and the untouched parts ─────────────────────────────────────── */

describe('the new storage is server-only, and the proven parts are unchanged', () => {
  const s = () => scenario();

  test('no client role can read the attempt store', () => {
    assert.equal(s().attempts_client_grants, 'none');
  });

  test('and it carries no RLS policy at all', () => {
    assert.equal(s().attempts_policies, '0');
  });

  test('neither fulfilment function is client-callable', () => {
    assert.equal(s().fulfil_fn_client_exec, 'none');
    assert.equal(s().elig_fn_client_exec, 'none');
  });

  test('record_hub_donation is still service-role only', () => {
    assert.equal(s().record_fn_client_exec, 'none');
  });

  test('search_path is pinned on both new privileged functions', () => {
    assert.equal(s().search_path_pinned, 'both');
  });

  test('amount bounds, currency and destination are untouched', () => {
    assert.match(intentFn, /const MIN_PENCE = 100/);
    assert.match(intentFn, /const MAX_PENCE = 1_000_000/);
    assert.match(intentFn, /currency:\s+'gbp'/);
    assert.match(intentFn, /baseParams\['transfer_data\[destination\]'\] = hub\.stripe_account_id/);
    assert.ok(!code(intentFn).includes('body.stripe_account'), 'a destination could come from the request');
  });

  test('SCA still resumes the same intent', () => {
    assert.match(intentFn, /status: 'requires_action', clientSecret: outcome\.clientSecret, payment_intent_id: outcome\.id/);
    assert.match(webClient, /settleSavedCardPayment\(data as ScaStart\)/);
    // The attempt is bound to the intent before the challenge branch returns.
    assert.ok(intentFn.indexOf('payment_intent_id: pi.id }).eq(') < intentFn.indexOf("outcome.kind === 'requires_action'"));
  });

  test('a failed payment still records nothing', () => {
    assert.match(intentFn, /outcome\.kind !== 'succeeded'/);
    assert.match(confirmFn, /pi\.status !== 'succeeded'/);
  });

  test('other paygates’ fulfillers are untouched', () => {
    for (const t of ['local_wallet_topup', 'unit_purchase', 'gift_purchase',
                     'event_tickets', 'hub_membership', 'product_order', 'shift_boost']) {
      assert.match(fulfilment, new RegExp(`case '${t}':`), `${t} lost its fulfiller`);
    }
  });
});
