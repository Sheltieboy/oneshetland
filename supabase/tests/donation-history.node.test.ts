/**
 * donation-history.node.test.ts — a donation becomes something you can look at.
 *
 * WHAT WAS MISSING
 *
 * The donation itself was recorded correctly — donor, hub, campaign, amount,
 * fee, message, anonymity, Gift Aid, payment reference, timestamp. Nobody could
 * see it. A donor who left the campaign page had no record of what they had
 * given, and a hub owner had campaign totals, a public donor wall and a Gift
 * Aid export but no itemised list of who gave what.
 *
 * So no second receipt table: hub_donations was already the authoritative row.
 * Three things were added to it, and two screens were added to read it.
 *
 * WHY THE THREE COLUMNS
 *
 *   payment_method  — could previously only be inferred from the SHAPE of
 *                     stripe_payment_intent_id ('pi_…' vs 'wallet_…'). Real
 *                     evidence, since our own code writes it, but true only
 *                     until somebody changes a string. Recorded explicitly now.
 *
 *   hub_name        — both foreign keys were ON DELETE CASCADE, so deleting a
 *   campaign_title    campaign or a hub would have deleted every donation to
 *                     it. No screen deletes either today, so nothing was lost;
 *                     it was one admin action away. Now SET NULL, with the
 *                     names snapshotted so the record still reads as something.
 *                     The snapshot also stops an edited campaign title
 *                     rewriting an old receipt.
 *
 * NO STATUS COLUMN. hub_donations only ever holds a payment Stripe reported as
 * succeeded, so "Completed" is a constant, not an invented state.
 *
 * PRIVACY
 *
 * The real donation was anonymous. Public sees "Anonymous". The donor sees
 * their own donation and that they chose anonymity. The hub admin sees "An
 * anonymous supporter" — which is not a new rule, it is what the notification
 * the admin already receives says. Gift Aid declarant details stay behind the
 * existing export.
 *
 * SAFETY
 * Database assertions run in a transaction that is never committed. The real
 * £2 donation is read, never written. No donation is made.
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

const migration = read('supabase/migrations/20260826090000_donation_history_fields.sql');
const hubsServer = web('lib/hubs-server.ts');
const donorPage = web('app/account/donations/page.tsx');
const ledgerPage = web('app/hubs/[id]/manage/donations/page.tsx');
const accountPage = web('app/account/page.tsx');
const campaignsAdmin = web('app/hubs/[id]/manage/campaigns/page.tsx');
const appApi = read('lib/hubs-api.ts');
const appScreen = read('app/my-donations.tsx');
const appMe = read('app/(tabs)/me.tsx');
const fulfilment = read('supabase/functions/_shared/fulfilment.ts');

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
  donor uuid; stranger uuid; hub uuid; other_hub uuid; camp uuid;
  n int; t text;
  v_donor int; v_stranger int; v_admin int; v_other_admin int; v_anon_read text;
begin
  select id into donor    from auth.users order by created_at limit 1;
  select id into stranger from auth.users order by created_at desc limit 1;
  select id into hub       from public.hubs where slug = 'demo-community-trust';
  select id into other_hub from public.hubs where slug = 'demo-rowing-club';

  insert into public.hub_campaigns (hub_id, title, status, goal_pence)
    values (hub, 'probe history campaign', 'active', 100000) returning id into camp;

  -- A card donation and a wallet donation by the same person.
  perform public.record_hub_donation(camp, hub, donor, 200, 23, 'probe card message', true,
    'pi_probe_hist_card', false, null, null, null, null, null);
  perform public.record_hub_donation(camp, hub, donor, 500, 0, null, false,
    'wallet_probe_hist', false, null, null, null, null, null);
  -- And one with Gift Aid, to check the declarant data stays put.
  perform public.record_hub_donation(camp, hub, donor, 1000, 35, null, false,
    'pi_probe_hist_ga', true, 'Ms', 'Ann', 'Probe', '1 Probe Road', 'ZE1 0AA');

  insert into r select 'method_card',   coalesce(payment_method,'NULL') from public.hub_donations where stripe_payment_intent_id = 'pi_probe_hist_card';
  insert into r select 'method_wallet', coalesce(payment_method,'NULL') from public.hub_donations where stripe_payment_intent_id = 'wallet_probe_hist';
  insert into r select 'hub_name_snapshot', coalesce(hub_name,'NULL')      from public.hub_donations where stripe_payment_intent_id = 'pi_probe_hist_card';
  insert into r select 'campaign_snapshot', coalesce(campaign_title,'NULL') from public.hub_donations where stripe_payment_intent_id = 'pi_probe_hist_card';
  insert into r select 'donor_amount', amount_pence::text from public.hub_donations where stripe_payment_intent_id = 'pi_probe_hist_card';
  insert into r select 'donor_message', coalesce(message,'NULL') from public.hub_donations where stripe_payment_intent_id = 'pi_probe_hist_card';
  insert into r select 'donor_anon', is_anonymous::text from public.hub_donations where stripe_payment_intent_id = 'pi_probe_hist_card';

  -- ── the snapshot does not follow an edit ───────────────────────────────
  update public.hub_campaigns set title = 'RENAMED AFTER THE FACT' where id = camp;
  insert into r select 'snapshot_survives_edit',
    case when campaign_title = 'probe history campaign' then 'unchanged' else 'REWRITTEN' end
    from public.hub_donations where stripe_payment_intent_id = 'pi_probe_hist_card';

  -- ── closing, ending, and deleting the campaign ─────────────────────────
  update public.hub_campaigns set status = 'closed', ends_at = now() - interval '1 day' where id = camp;
  select count(*) into n from public.hub_donations where campaign_id = camp;
  insert into r values ('survives_close_and_end', n::text);

  delete from public.hub_campaigns where id = camp;
  select count(*) into n from public.hub_donations where stripe_payment_intent_id like 'pi_probe_hist%' or stripe_payment_intent_id = 'wallet_probe_hist';
  insert into r values ('survives_campaign_delete', n::text);
  insert into r select 'delete_nulls_link_keeps_name',
    case when campaign_id is null and campaign_title = 'probe history campaign' then 'ok' else 'BROKEN' end
    from public.hub_donations where stripe_payment_intent_id = 'pi_probe_hist_card';

  insert into r select 'no_cascading_fk',
    case when exists (select 1 from pg_constraint
                       where conrelid = 'public.hub_donations'::regclass and contype='f'
                         and pg_get_constraintdef(oid) ilike '%on delete cascade%')
         then 'CASCADES' else 'none' end;

  -- ── who can read it ────────────────────────────────────────────────────
  declare begin
    perform set_config('role','authenticated',true);
    perform set_config('request.jwt.claims', json_build_object('sub',donor,'role','authenticated')::text, true);
    select count(*) into v_donor from public.hub_donations where stripe_payment_intent_id like '%probe_hist%';

    perform set_config('request.jwt.claims', json_build_object('sub',stranger,'role','authenticated')::text, true);
    select count(*) into v_stranger from public.hub_donations where stripe_payment_intent_id like '%probe_hist%';

    perform set_config('role','anon',true);
    perform set_config('request.jwt.claims', null, true);
    begin
      select count(*) into n from public.hub_donations where stripe_payment_intent_id like '%probe_hist%';
      v_anon_read := 'read:' || n::text;
    exception when others then v_anon_read := 'refused'; end;

    perform set_config('role','postgres',true);
    insert into r values ('donor_sees_own', v_donor::text);
    insert into r values ('stranger_sees', v_stranger::text);
    insert into r values ('anon_sees', v_anon_read);
  end;

  -- ── hub admin, and an admin of a different hub ─────────────────────────
  insert into public.hub_members (hub_id, user_id, role, status) values (hub, stranger, 'owner', 'active')
    on conflict do nothing;
  declare begin
    perform set_config('role','authenticated',true);
    perform set_config('request.jwt.claims', json_build_object('sub',stranger,'role','authenticated')::text, true);
    select count(*) into v_admin from public.hub_donations where stripe_payment_intent_id like '%probe_hist%';
    perform set_config('role','postgres',true);
    insert into r values ('hub_admin_sees', v_admin::text);
  end;
  delete from public.hub_members where hub_id = hub and user_id = stranger;

  insert into public.hub_members (hub_id, user_id, role, status) values (other_hub, stranger, 'owner', 'active')
    on conflict do nothing;
  declare begin
    perform set_config('role','authenticated',true);
    perform set_config('request.jwt.claims', json_build_object('sub',stranger,'role','authenticated')::text, true);
    select count(*) into v_other_admin from public.hub_donations where stripe_payment_intent_id like '%probe_hist%';
    perform set_config('role','postgres',true);
    insert into r values ('other_hub_admin_sees', v_other_admin::text);
  end;

  -- ── Gift Aid stays where it belongs ────────────────────────────────────
  insert into r select 'giftaid_stored',
    case when gift_aid and ga_postcode = 'ZE1 0AA' then 'stored' else 'LOST' end
    from public.hub_donations where stripe_payment_intent_id = 'pi_probe_hist_ga';
end $$;
select step, outcome from r;
`;

let cached: Record<string, string> | null = null;
function scenario(): Record<string, string> {
  if (!cached) cached = Object.fromEntries(runSql(SCENARIO).map((r) => [String(r.step), String(r.outcome)]));
  return cached;
}

/* ── the existing row was enough ──────────────────────────────────────────── */

describe('hub_donations remains the authoritative record', () => {
  test('no second receipt table was created', () => {
    assert.ok(!/create table[^;]*receipt/i.test(migration));
    assert.ok(!/create table (if not exists )?public\.donation_/i.test(migration));
  });

  test('only three columns were added', () => {
    assert.match(migration, /add column if not exists payment_method\s+text/);
    assert.match(migration, /add column if not exists hub_name\s+text/);
    assert.match(migration, /add column if not exists campaign_title\s+text/);
  });

  test('and no status column was invented', () => {
    assert.ok(!/add column if not exists status/.test(migration));
    // Every row is a succeeded payment, so the screens say so as a constant.
    assert.match(donorPage, />Completed</);
    assert.match(ledgerPage, />Completed</);
  });
});

/* ── payment method ───────────────────────────────────────────────────────── */

describe('card and wallet are recorded, not guessed', () => {
  const s = () => scenario();

  test('a card donation records card', () => {
    assert.equal(s().method_card, 'card');
  });

  test('a wallet donation records wallet', () => {
    assert.equal(s().method_wallet, 'wallet');
  });

  test('the backfill only claimed what the reference proves', () => {
    assert.match(migration, /when stripe_payment_intent_id like 'pi\\_%'\s+then 'card'/);
    assert.match(migration, /when stripe_payment_intent_id like 'wallet\\_%' then 'wallet'/);
    assert.match(migration, /else null/);
    assert.match(migration, /where payment_method is null and stripe_payment_intent_id is not null/);
  });

  test('no screen parses the payment reference to work it out', () => {
    for (const [name, src] of [['web donor', donorPage], ['web ledger', ledgerPage], ['app', appScreen]] as const) {
      assert.ok(!code(src).includes('stripe_payment_intent_id'), `${name} reads the payment reference`);
      assert.ok(!/startsWith\(['"]pi_/.test(code(src)), `${name} parses a Stripe prefix`);
    }
  });
});

/* ── durability ───────────────────────────────────────────────────────────── */

describe('financial history is not deletable', () => {
  const s = () => scenario();

  test('neither foreign key cascades any more', () => {
    assert.equal(s().no_cascading_fk, 'none');
    assert.match(migration, /references public\.hub_campaigns\(id\) on delete set null/);
    assert.match(migration, /references public\.hubs\(id\) on delete set null/);
  });

  test('the record survives the campaign closing and ending', () => {
    assert.equal(s().survives_close_and_end, '3');
  });

  test('and survives the campaign being deleted outright', () => {
    assert.equal(s().survives_campaign_delete, '3');
  });

  test('the link is nulled and the name kept', () => {
    assert.equal(s().delete_nulls_link_keeps_name, 'ok');
  });

  test('an edited campaign title does not rewrite an old receipt', () => {
    assert.equal(s().snapshot_survives_edit, 'unchanged');
  });

  test('history is never filtered to active campaigns', () => {
    const fn = hubsServer.match(/export async function getMyDonations[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(fn.length > 0);
    assert.ok(!/status/.test(fn), 'donor history filters on campaign status');
    assert.ok(!/ends_at/.test(fn), 'donor history filters on the campaign end date');
  });
});

/* ── who sees what ────────────────────────────────────────────────────────── */

describe('privacy and authorisation', () => {
  const s = () => scenario();

  test('the donor reads their own donations', () => {
    assert.equal(s().donor_sees_own, '3');
  });

  test('an unrelated signed-in user reads none of them', () => {
    assert.equal(s().stranger_sees, '0');
  });

  test('signed out reads none', () => {
    assert.equal(s().anon_sees, 'read:0');
  });

  test('an admin of the receiving hub reads them', () => {
    assert.equal(s().hub_admin_sees, '3');
  });

  test('an admin of a different hub reads none', () => {
    assert.equal(s().other_hub_admin_sees, '0');
  });

  test('RLS was not loosened — the policy is the one that was already there', () => {
    assert.ok(!/create policy/i.test(migration), 'the migration adds a policy');
    assert.ok(!/hub_donations.*enable row level security/i.test(migration));
  });
});

/* ── anonymity ────────────────────────────────────────────────────────────── */

describe('an anonymous donation stays anonymous', () => {
  test('the public wall is untouched and still says Anonymous', () => {
    // The migration refuses to commit if get_campaign_donors gains donor_user_id.
    assert.match(migration, /would expose donor_user_id/);
    assert.ok(!/create or replace function public\.get_campaign_donors/.test(migration));
  });

  test('the donor can see that they chose anonymity', () => {
    assert.equal(scenario().donor_anon, 'true');
    assert.match(donorPage, /d\.is_anonymous && \(/);
    assert.match(donorPage, /Anonymous donation/);
    assert.match(appScreen, /d\.is_anonymous \?/);
  });

  test('the hub admin sees "An anonymous supporter", the same words the product already uses', () => {
    assert.match(hubsServer, /r\.is_anonymous\s*\n?\s*\? "An anonymous supporter"/);
    assert.match(fulfilment, /let donorName = 'An anonymous supporter'/);
  });

  test('the ledger never asks a profile for an anonymous donor', () => {
    const fn = hubsServer.match(/export async function getHubDonationLedger[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(fn, /rows\.filter\(\(r\) => !r\.is_anonymous && r\.donor_user_id\)/);
  });

  test('and never hands donor_user_id to the page', () => {
    const fn = hubsServer.match(/export async function getHubDonationLedger[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(fn, /rows\.map\(\(\{ donor_user_id, \.\.\.r \}\)/);
    assert.ok(!code(ledgerPage).includes('donor_user_id'));
  });
});

/* ── what the screens show ────────────────────────────────────────────────── */

describe('the history screens', () => {
  const s = () => scenario();

  test('the donor sees the amount they gave, not the hub net', () => {
    assert.equal(s().donor_amount, '200');
    assert.match(donorPage, /gbp\(d\.amount_pence\)/);
    assert.ok(!code(donorPage).includes('fee_pence'), 'the donor is shown the platform fee');
    assert.ok(!code(appScreen).includes('fee_pence'));
  });

  test('the donor keeps their own message', () => {
    assert.equal(s().donor_message, 'probe card message');
    assert.match(donorPage, /\{d\.message &&/);
  });

  test('Gift Aid shows as a state, never an address', () => {
    assert.equal(s().giftaid_stored, 'stored');
    assert.match(donorPage, /Gift Aid claimed/);
    for (const [name, src] of [['web donor', donorPage], ['web ledger', ledgerPage], ['app', appScreen]] as const) {
      for (const leak of ['ga_postcode', 'ga_address', 'ga_first_name', 'ga_last_name']) {
        assert.ok(!code(src).includes(leak), `${name} renders ${leak}`);
      }
    }
    assert.match(ledgerPage, /manage\/giftaid/);
  });

  test('no Stripe or internal identifier reaches a screen', () => {
    for (const [name, src] of [['web donor', donorPage], ['web ledger', ledgerPage],
                               ['app', appScreen], ['queries', hubsServer]] as const) {
      for (const leak of ['stripe_payment_intent_id', 'stripe_customer', 'stripe_account', 'client_secret']) {
        assert.ok(!code(src).includes(leak), `${name} exposes ${leak}`);
      }
    }
  });

  test('both are reachable', () => {
    assert.match(accountPage, /href: "\/account\/donations", title: "My donations"/);
    assert.match(campaignsAdmin, /manage\/donations`/);
    assert.match(appMe, /router\.push\('\/my-donations'\)/);
    assert.match(read('app/_layout.tsx'), /<Stack\.Screen\s+name="my-donations"/);
  });

  test('the app screen is read-only — no donation can be started from it', () => {
    const src = code(appScreen);
    for (const banned of ['create-hub-donation-intent', 'confirm-hub-donation', 'walletCheckout',
                          'startHubDonation', 'PaymentSheet', 'Donate']) {
      assert.ok(!src.includes(banned), `the app history screen can start a payment (${banned})`);
    }
  });
});

/* ── parity and nothing else moved ────────────────────────────────────────── */

describe('card and wallet parity, and no double counting', () => {
  test('both routes appear in the same history', () => {
    assert.equal(scenario().method_card, 'card');
    assert.equal(scenario().method_wallet, 'wallet');
    const fn = hubsServer.match(/export async function getMyDonations[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(!/payment_method.*eq/.test(fn), 'donor history filters by payment method');
  });

  test('the wallet ledger is untouched, so wallet money is not counted twice', () => {
    assert.ok(!migration.includes('local_wallet_transactions'));
    assert.match(read('supabase/functions/wallet-checkout/index.ts'), /description: `Donation to \$\{hub\.name\}`/);
  });

  test('a failed payment still records nothing', () => {
    assert.match(read('supabase/functions/confirm-hub-donation/index.ts'), /pi\.status !== 'succeeded'/);
    assert.match(read('supabase/functions/create-hub-donation-intent/index.ts'), /outcome\.kind !== 'succeeded'/);
  });

  test('other paygates are unchanged', () => {
    for (const t of ['local_wallet_topup', 'unit_purchase', 'gift_purchase', 'event_tickets',
                     'hub_donation', 'hub_membership', 'product_order', 'shift_boost']) {
      assert.match(fulfilment, new RegExp(`case '${t}':`), `${t} lost its fulfiller`);
    }
  });

  test('the real £2 donation reconciles and appears exactly once', () => {
    const r = runSql(`
      select (select count(*)::text from public.hub_donations
               where stripe_payment_intent_id like 'pi\\_%' and amount_pence = 200
                 and is_anonymous and payment_method = 'card')                       as real_row,
             (select count(*)::text from public.hub_donations
               where stripe_payment_intent_id is not null
                 and payment_method is null)                                          as card_rows_without_method,
             (select count(*)::text from public.hub_donations where hub_name is null) as rows_without_hub_name;`)[0];
    assert.equal(r.real_row, '1', 'the real £2 anonymous card donation is not there exactly once');
    assert.equal(r.card_rows_without_method, '0');
    assert.equal(r.rows_without_hub_name, '0');
  });
});
