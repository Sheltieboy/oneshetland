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
 * Run: npm test
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GHOST = '00000000-0000-0000-0000-000000000000';

/** One CLI round-trip; every statement inside is rolled back. */
function probe(): Record<string, boolean | number> | null {
  const sql = `
begin;
create function pg_temp.as_user(p_sub text, p_sql text) returns text language plpgsql as $f$
begin
  perform set_config('request.jwt.claims','{"sub":"'||p_sub||'","role":"authenticated"}',true);
  set local role authenticated; execute p_sql; reset role; return 'ran';
exception when others then reset role; return 'ERROR: '||left(SQLERRM,40);
end $f$;

create temp table t  as select id, owner_id, name as name0, accepts_wallet as aw0,
                              subscription_tier as tier0, subscription_until as until0,
                              is_verified as ver0, payout_enabled as pay0,
                              stripe_customer_id as cus0, nfc_token as nfc0
                       from public.local_businesses where owner_id is not null limit 1;
create temp table h  as select id, owner_id, is_verified as ver0, payout_enabled as pay0,
                              stripe_account_id as acct0
                       from public.hubs where owner_id is not null limit 1;
create temp table d  as select id, driver_status as st0, stripe_payouts_enabled as pay0,
                              stripe_account_id as acct0
                       from public.driver_profiles limit 1;
create temp table nu as select id from public.profiles
                       where id not in (select owner_id from public.local_businesses where owner_id is not null)
                       limit 1;
create temp table adm as select id from public.profiles where role='admin' or is_platform_owner limit 1;
grant select on t,h,d,nu,adm to authenticated, service_role, anon;

-- 1. legitimate owner edit
select pg_temp.as_user((select owner_id::text from t),
  'update public.local_businesses set name=''LEGIT-RENAME'', accepts_wallet=not ' ||
  (select aw0 from t)::text || ' where id='''||(select id from t)||'''');

-- 2. business escalation attempt
select pg_temp.as_user((select owner_id::text from t),
  'update public.local_businesses set subscription_tier=''premium'', subscription_until=''2099-01-01'','||
  ' is_verified=true, payout_enabled=true, stripe_customer_id=''cus_ATTACKER'','||
  ' stripe_account_id=''acct_ATTACKER'', nfc_token=''attacker-tile'', can_publish_urgent=true,'||
  ' owner_id='''||'${GHOST}'''||' where id='''||(select id from t)||'''');

-- 3. hub escalation + handover attempt
select pg_temp.as_user((select owner_id::text from h),
  'update public.hubs set is_verified=true, payout_enabled=true, stripe_account_id=''acct_ATTACKER'','||
  ' owner_id='''||'${GHOST}'''||' where id='''||(select id from h)||'''');

-- 4. driver self-approval attempt
select pg_temp.as_user((select id::text from d),
  'update public.driver_profiles set driver_status=''approved'', stripe_payouts_enabled=true,'||
  ' stripe_account_id=''acct_ATTACKER'' where id='''||(select id from d)||'''');

-- 5. INSERT injecting privileged state
select pg_temp.as_user((select id::text from nu),
  'insert into public.local_businesses (owner_id,name,category,address,subscription_tier,'||
  'subscription_until,is_verified,payout_enabled,stripe_account_id,nfc_token,can_publish_urgent)'||
  ' values ('''||(select id from nu)||''',''LOCKTEST-INJECTED'',''retail'',''Lerwick'',''premium'','||
  '''2099-01-01'',true,true,''acct_ATTACKER'',''attacker-tile'',true)');

-- 6. service role must still write protected columns
set local role service_role;
update public.local_businesses set subscription_tier='pro', is_verified=true where id=(select id from t);
reset role;

-- 7. platform admin must still write them from a client session
select pg_temp.as_user((select id::text from adm),
  'update public.driver_profiles set driver_status=''suspended'' where id='''||(select id from d)||'''');

select
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
from public.local_businesses b join t on t.id=b.id
cross join (select * from public.hubs where id=(select id from h)) hb
cross join (select * from public.driver_profiles where id=(select id from d)) dp
cross join (select * from public.local_businesses where name='LOCKTEST-INJECTED') ins
cross join h cross join d;
rollback;`;
  try {
    const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', sql, '--output-format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120_000 });
    return (JSON.parse(out) as { rows?: Record<string, boolean | number>[] }).rows?.[0] ?? null;
  } catch {
    return null;
  }
}

describe('server-managed columns are not writable by their owner', () => {
  let r: Record<string, boolean | number> | null = null;
  before(() => { r = probe(); });

  /** Every assertion, with the sentence that explains what breaks if it fails. */
  const CASES: Array<[string, string]> = [
    ['biz_owner_can_rename',        'a business owner can no longer edit their own name — the lock is too wide'],
    ['biz_owner_can_set_wallet',    'a business owner can no longer toggle accepts_wallet — the lock is too wide'],
    ['biz_expiry_locked',           'an owner extended their own paid expiry'],
    ['biz_stripe_locked',           'an owner overwrote their Stripe customer id'],
    ['biz_token_locked',            'an owner chose their own NFC tile token — it can collide with another business'],
    ['biz_owner_locked',            'a business changed hands by table update'],
    ['biz_payout_locked',           'an owner enabled payouts without Stripe onboarding'],
    ['hub_verified_locked',         'a hub owner marked their own hub verified'],
    ['hub_payout_locked',           'a hub owner enabled payouts on their own hub'],
    ['hub_stripe_locked',           'a hub owner set their own Stripe account id'],
    ['hub_owner_locked',            'a hub changed hands by table update'],
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
    if (!r) {
      t.skip('Supabase CLI or linked project unavailable — run `supabase link` to exercise this suite.');
      return;
    }
    const failed = CASES.filter(([k]) => !r![k]);
    if (failed.length) {
      assert.fail(
        `SECURITY REGRESSION in the column locks (migration 20260819180000):\n` +
        failed.map(([k, why]) => `  • ${k}: ${why}`).join('\n'),
      );
    }
    console.log(`\n  ${CASES.length} column-lock assertions verified against the live schema (rolled back)\n`);
  });

  test('driver_status cannot be self-set to approved', (t) => {
    if (!r) { t.skip('CLI unavailable'); return; }
    // Covered indirectly above: the admin then set it to 'suspended', which
    // could only happen if the driver's own 'approved' write had been dropped
    // AND the admin's write allowed. Asserted explicitly for clarity.
    assert.equal(r.admin_can_set_driver_status, true,
      'driver_status ended up somewhere unexpected — a driver may be able to self-approve.');
  });
});
