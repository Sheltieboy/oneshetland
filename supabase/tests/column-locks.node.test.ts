/**
 * column-locks.node.test.ts — an owner may edit their row, not their entitlement.
 *
 * WHY THIS TEST EXISTS
 * RLS decides which ROWS you may write; it never decides which COLUMNS. The
 * owner policies on local_businesses, hubs and driver_profiles permitted the
 * row, so they permitted every column of it. Before migration 20260819180000 all
 * four of these succeeded against production:
 *
 *   business owner → subscription_tier='premium', is_verified=true,
 *                    payout_enabled=true, stripe_customer_id=…, nfc_token=…
 *   hub owner      → is_verified=true, payout_enabled=true, stripe_account_id=…
 *   hub owner      → owner_id=<somebody else>   (uncontrolled handover)
 *   driver         → driver_status='approved'   (self-approval)
 *
 * subscription_tier is the source of truth for the whole paid model, so that
 * first line was the £12/£29 tiers for free.
 *
 * HOW IT TESTS
 * Role simulation over the linked project: set request.jwt.claims and SET ROLE
 * exactly as PostgREST does, attempt the write, then read the row back. Every
 * case runs inside a transaction that is always rolled back, so production data
 * is never changed. Skips with a clear message when the CLI or link is absent.
 *
 * WHY THE FIXTURES ARE BUILT, NOT FOUND
 * The first version picked "any owned business / any hub / any driver" with
 * LIMIT 1. By September every owned business, and the first driver row, belonged
 * to a platform admin — a trusted writer by design, so the locks step aside —
 * and the hubs table was empty. The final SELECT then returned no row,
 * `supabase db query` fell back to the last NON-EMPTY result set (one of the
 * as_user calls), every key read as undefined, and all the assertions failed at
 * once, in both directions, under a SECURITY REGRESSION banner. So:
 *   • the subject is a non-admin profile, and the business, hub and driver row
 *     it writes to are created inside the rolled-back transaction;
 *   • as_user results go into a temp table, so the final SELECT is the only
 *     statement that returns rows, and it always returns exactly one;
 *   • a missing fixture or malformed result fails as a HARNESS FAULT, never as
 *     a security regression.
 *
 * Run: npm test
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GHOST = '00000000-0000-0000-0000-000000000000';

type ProbeResult =
  | { kind: 'unavailable' }
  | { kind: 'broken'; why: string }
  | { kind: 'ok'; row: Record<string, unknown> };

/** One CLI round-trip; every statement inside is rolled back. */
function probe(): ProbeResult {
  const sql = `
begin;
create function pg_temp.as_user(p_sub text, p_sql text) returns text language plpgsql as $f$
begin
  perform set_config('request.jwt.claims','{"sub":"'||p_sub||'","role":"authenticated"}',true);
  set local role authenticated; execute p_sql; reset role; return 'ran';
exception when others then reset role; return 'ERROR: '||left(SQLERRM,120);
end $f$;

-- Fixtures, written as the migration role (a trusted writer) before any claims
-- are set. The subject is an ordinary signed-up user: not staff, not the
-- platform owner, not already a driver.
create temp table u   as select id from public.profiles
                         where not (coalesce(role,'') in ('admin','moderator')
                                    or coalesce(is_platform_owner,false))
                           and id not in (select id from public.driver_profiles)
                         limit 1;
-- accepts_wallet starts ON so the owner's legitimate edit can switch it OFF —
-- the one wallet change the commercial-terms guard allows without acceptance.
insert into public.local_businesses (owner_id,name,category,address,accepts_wallet)
  select id,'LOCKTEST-BIZ','retail','Lerwick',true from u;
insert into public.hubs (owner_id,name) select id,'LOCKTEST-HUB' from u;
insert into public.driver_profiles (id,driver_status) select id,'pending' from u;

create temp table t  as select id, owner_id, name as name0, accepts_wallet as aw0,
                              subscription_tier as tier0, subscription_until as until0,
                              is_verified as ver0, payout_enabled as pay0,
                              stripe_customer_id as cus0, nfc_token as nfc0
                       from public.local_businesses where name='LOCKTEST-BIZ';
create temp table h  as select id, owner_id, is_verified as ver0, payout_enabled as pay0,
                              stripe_account_id as acct0
                       from public.hubs where name='LOCKTEST-HUB';
create temp table d  as select id, driver_status as st0, stripe_payouts_enabled as pay0,
                              stripe_account_id as acct0
                       from public.driver_profiles where id=(select id from u);
create temp table adm as select id from public.profiles where role='admin' or is_platform_owner limit 1;
create temp table steps (n int generated always as identity, r text);
create temp table d_after_self (driver_status text);
grant select on u,t,h,d,adm to authenticated, service_role, anon;
grant all on steps, d_after_self to authenticated, service_role, anon;

-- 1. legitimate owner edit
insert into steps(r) select pg_temp.as_user((select owner_id::text from t),
  'update public.local_businesses set name=''LEGIT-RENAME'', accepts_wallet=false' ||
  ' where id='''||(select id from t)||'''');

-- 2. business escalation attempt
insert into steps(r) select pg_temp.as_user((select owner_id::text from t),
  'update public.local_businesses set subscription_tier=''premium'', subscription_until=''2099-01-01'','||
  ' is_verified=true, payout_enabled=true, stripe_customer_id=''cus_ATTACKER'','||
  ' stripe_account_id=''acct_ATTACKER'', nfc_token=''attacker-tile'', can_publish_urgent=true,'||
  ' owner_id='''||'${GHOST}'''||' where id='''||(select id from t)||'''');

-- 3. hub escalation + handover attempt
insert into steps(r) select pg_temp.as_user((select owner_id::text from h),
  'update public.hubs set is_verified=true, payout_enabled=true, stripe_account_id=''acct_ATTACKER'','||
  ' owner_id='''||'${GHOST}'''||' where id='''||(select id from h)||'''');

-- 4. driver self-approval attempt, snapshotted before the admin touches the row
insert into steps(r) select pg_temp.as_user((select id::text from d),
  'update public.driver_profiles set driver_status=''approved'', stripe_payouts_enabled=true,'||
  ' stripe_account_id=''acct_ATTACKER'' where id='''||(select id from d)||'''');
insert into d_after_self select driver_status from public.driver_profiles where id=(select id from d);

-- 5. INSERT injecting privileged state
insert into steps(r) select pg_temp.as_user((select id::text from u),
  'insert into public.local_businesses (owner_id,name,category,address,subscription_tier,'||
  'subscription_until,is_verified,payout_enabled,stripe_account_id,nfc_token,can_publish_urgent)'||
  ' values ('''||(select id from u)||''',''LOCKTEST-INJECTED'',''retail'',''Lerwick'',''premium'','||
  '''2099-01-01'',true,true,''acct_ATTACKER'',''attacker-tile'',true)');

-- 6. service role must still write protected columns
set local role service_role;
update public.local_businesses set subscription_tier='pro', is_verified=true where id=(select id from t);
reset role;

-- 7. platform admin must still write them from a client session
insert into steps(r) select pg_temp.as_user((select id::text from adm),
  'update public.driver_profiles set driver_status=''suspended'' where id='''||(select id from d)||'''');

-- The only statement that returns rows, and it always returns exactly one.
select
  (select count(*) from u)   = 1                         as fx_subject,
  (select count(*) from t)   = 1                         as fx_business,
  (select count(*) from h)   = 1                         as fx_hub,
  (select count(*) from d)   = 1                         as fx_driver,
  (select count(*) from adm) = 1                         as fx_admin,
  (select string_agg(n||':'||r, ' | ' order by n) from steps) as steps,
  (b.name='LEGIT-RENAME')                                as biz_owner_can_rename,
  (b.accepts_wallet is distinct from t.aw0)              as biz_owner_can_set_wallet,
  (b.subscription_tier='pro')                            as service_role_can_set_tier,
  (b.subscription_until is not distinct from t.until0)   as biz_expiry_locked,
  (b.stripe_customer_id is not distinct from t.cus0)     as biz_stripe_locked,
  (b.nfc_token is not distinct from t.nfc0)              as biz_token_locked,
  (b.owner_id is not distinct from t.owner_id)           as biz_owner_locked,
  (b.payout_enabled is not distinct from t.pay0)         as biz_payout_locked,
  (hb.is_verified is not distinct from h.ver0)           as hub_verified_locked,
  (hb.payout_enabled is not distinct from h.pay0)        as hub_payout_locked,
  (hb.stripe_account_id is not distinct from h.acct0)    as hub_stripe_locked,
  (hb.owner_id is not distinct from h.owner_id)          as hub_owner_locked,
  ((select driver_status from d_after_self) = d.st0)     as driver_status_locked,
  (dp.driver_status='suspended')                         as admin_can_set_driver_status,
  (dp.stripe_payouts_enabled is not distinct from d.pay0) as driver_payout_locked,
  (dp.stripe_account_id is not distinct from d.acct0)    as driver_stripe_locked,
  (ins.subscription_tier='free')                         as insert_tier_forced_free,
  (ins.subscription_until is null)                       as insert_no_expiry,
  (ins.is_verified=false)                                as insert_not_verified,
  (ins.payout_enabled=false)                             as insert_no_payout,
  (ins.stripe_account_id is null)                        as insert_no_stripe,
  (ins.nfc_token is null)                                as insert_no_token,
  (ins.can_publish_urgent=false)                         as insert_no_urgent,
  (ins.name='LOCKTEST-INJECTED')                         as insert_kept_legit_fields
from (select 1) one
left join t on true
left join public.local_businesses b on b.id=t.id
left join h on true
left join public.hubs hb on hb.id=h.id
left join d on true
left join public.driver_profiles dp on dp.id=d.id
left join public.local_businesses ins on ins.name='LOCKTEST-INJECTED';
rollback;`;
  let out: string;
  try {
    out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', sql, '--output-format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120_000 });
  } catch {
    return { kind: 'unavailable' };
  }
  let row: Record<string, unknown> | undefined;
  try {
    row = (JSON.parse(out) as { rows?: Record<string, unknown>[] }).rows?.[0];
  } catch {
    return { kind: 'broken', why: `the CLI output was not JSON: ${out.slice(0, 200)}` };
  }
  if (!row || !('fx_subject' in row)) {
    return { kind: 'broken', why: `the probe's final SELECT did not come back; got ${JSON.stringify(row)}` };
  }
  const missing = ['fx_subject', 'fx_business', 'fx_hub', 'fx_driver', 'fx_admin'].filter((k) => row![k] !== true);
  if (missing.length) {
    return { kind: 'broken', why: `fixtures missing: ${missing.join(', ')} (steps: ${row.steps})` };
  }
  return { kind: 'ok', row };
}

describe('server-managed columns are not writable by their owner', () => {
  let p: ProbeResult = { kind: 'unavailable' };
  before(() => { p = probe(); });

  /** The probe row; skips when there is no CLI, fails as a harness fault when the probe itself broke. */
  function rowOrSkip(t: { skip: (msg: string) => void }): Record<string, unknown> | null {
    if (p.kind === 'unavailable') {
      t.skip('Supabase CLI or linked project unavailable — run `supabase link` to exercise this suite.');
      return null;
    }
    if (p.kind === 'broken') {
      assert.fail(`HARNESS FAULT, not a security result — the column locks were not exercised: ${p.why}`);
    }
    return p.row;
  }

  /** Every assertion, with the sentence that explains what breaks if it fails. */
  const CASES: Array<[string, string]> = [
    ['biz_owner_can_rename',        'a business owner can no longer edit their own name — the lock is too wide'],
    ['biz_owner_can_set_wallet',    'a business owner can no longer switch accepts_wallet off — the lock is too wide'],
    ['biz_expiry_locked',           'an owner extended their own paid expiry'],
    ['biz_stripe_locked',           'an owner overwrote their Stripe customer id'],
    ['biz_token_locked',            'an owner chose their own NFC tile token — it can collide with another business'],
    ['biz_owner_locked',            'a business changed hands by table update'],
    ['biz_payout_locked',           'an owner enabled payouts without Stripe onboarding'],
    ['hub_verified_locked',         'a hub owner marked their own hub verified'],
    ['hub_payout_locked',           'a hub owner enabled payouts on their own hub'],
    ['hub_stripe_locked',           'a hub owner set their own Stripe account id'],
    ['hub_owner_locked',            'a hub changed hands by table update'],
    ['driver_status_locked',        'a driver set their own driver_status — self-approval'],
    ['driver_payout_locked',        'a driver enabled their own payouts'],
    ['driver_stripe_locked',        'a driver set their own Stripe account id'],
    ['insert_tier_forced_free',     'a new business was created already on a paid tier'],
    ['insert_no_expiry',            'a new business was created with a paid expiry'],
    ['insert_not_verified',         'a new business was created already verified'],
    ['insert_no_payout',            'a new business was created with payouts enabled'],
    ['insert_no_stripe',            'a new business was created carrying a Stripe account id'],
    ['insert_no_token',             'a new business was created carrying a chosen NFC token'],
    ['insert_no_urgent',            'a new business was created able to publish urgent notices'],
    ['insert_kept_legit_fields',    'the insert lost its legitimate fields — the lock is too wide'],
    ['service_role_can_set_tier',   'the backend can no longer set a tier — Stripe webhooks are broken'],
    ['admin_can_set_driver_status', 'a platform admin can no longer approve a driver — the admin screens are broken'],
  ];

  test('business, hub and driver column locks', (t) => {
    const r = rowOrSkip(t);
    if (!r) return;
    const failed = CASES.filter(([k]) => r[k] !== true);
    if (failed.length) {
      assert.fail(
        `SECURITY REGRESSION in the column locks (migration 20260819180000):\n` +
        failed.map(([k, why]) => `  • ${k}: ${why}`).join('\n') +
        `\n  steps: ${r.steps}`,
      );
    }
    console.log(`\n  ${CASES.length} column-lock assertions verified against the live schema (rolled back)\n`);
  });

  test('driver_status cannot be self-set to approved', (t) => {
    const r = rowOrSkip(t);
    if (!r) return;
    // The driver starts 'pending'; after their own 'approved' write it must
    // still be 'pending', and the admin's 'suspended' must then land.
    assert.equal(r.driver_status_locked, true, 'a driver set their own driver_status to approved.');
    assert.equal(r.admin_can_set_driver_status, true,
      'a platform admin can no longer set driver_status — the admin screens are broken.');
  });
});
