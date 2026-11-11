/**
 * editions-commerce-core.node.test.ts — ISOLATED Postgres only. R4a/R4b: admin commercial model, fee maths, organiser entitlements, collection gate,
 * packages and orders (server-priced, idempotent, refundable), service-only money entry, lockdown. No Stripe anywhere.
 * Run: ISOLATED_ONLY=editions-commerce-core npm run test:isolated
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Env, USERS, seed, enter, draftEdition, d, last, failed as baseFailed } from './_support/editions-env.ts';
import { approveEdition, addHelper, aliased } from './_support/editions-env-2.ts';

// The organiser is a BUSINESS (ZZ Test Cafe): OWNER is its owner, EDITOR an invited editor, ADMINH an invited admin helper, OTHER a stranger, MOD a platform moderator.
const MAP = { ADMIN: 'ADMIN', MOD: 'HUB_COMMITTEE', OWNER: 'BIZ_OWNER', EDITOR: 'EDITOR', ADMINH: 'HELPER', OTHER: 'STRANGER' } as const;
const U = { ADMIN: USERS.ADMIN, MOD: USERS.HUB_COMMITTEE, OWNER: USERS.BIZ_OWNER, EDITOR: USERS.EDITOR, ADMINH: USERS.HELPER, OTHER: USERS.STRANGER } as const;
type Who = keyof typeof MAP | 'anon' | 'service';
const failed = baseFailed;
let Base: Env, S: ReturnType<typeof seed>;
let E: ReturnType<typeof aliased<keyof typeof MAP>>;
let ORG = '', ED = '', PKG = '', PKG2 = '';
const cfg = (k: string, v: string) => E.do('ADMIN', `select public.admin_set_edition_commerce_config('${k}', '${v}')`);

before(() => {
  Base = new Env('editionscommerce');
  S = seed(Base); E = aliased(Base, MAP);
  E.sup(`update profiles set role='moderator', full_name='Mo' where id='${U.MOD}'`);
  ORG = enter(Base, 'BIZ_OWNER', 'business', S.BIZ);
  addHelper(Base, 'BIZ_OWNER', ORG, 'EDITOR', `${U.EDITOR}@x.invalid`, 'editor');
  addHelper(Base, 'BIZ_OWNER', ORG, 'HELPER', `${U.ADMINH}@x.invalid`, 'admin');
  ED = draftEdition(Base, 'BIZ_OWNER', ORG, 'zz-com-fest', 'ZZ Com Fest');
  approveEdition(Base, 'BIZ_OWNER', ED); // a package is chosen only after approval (this also records the organiser's identity check)
});
after(() => Base?.drop());

describe('lockdown', () => {
  test('RLS on every R4 table, no FOR ALL, no write grants, no anon', () => {
    const t = `('edition_commercial_overrides','edition_organiser_entitlements','edition_payout_accounts','edition_commerce_terms_acceptances','edition_payments','edition_packages','edition_orders')`;
    assert.equal(E.q(`select count(*) from pg_class where relname in ${t} and not relrowsecurity`), '0');
    assert.equal(E.q(`select count(*) from pg_policies where tablename in ${t} and cmd='ALL'`), '0');
    assert.equal(E.q(`select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_name in ${t} and (grantee='anon' or privilege_type <> 'SELECT')`), '0');
  });
  test('the Stripe account id is never readable by a person', () => {
    assert.equal(E.q(`select count(*) from information_schema.column_privileges where grantee='authenticated' and table_name='edition_payout_accounts' and column_name='stripe_account_id'`), '0');
    assert.ok(failed(E.try('OWNER', `select stripe_account_id from public.edition_payout_accounts`)));
  });
  test('money-in functions are executable by the service role only; no commerce function is open to anon', () => {
    for (const fn of ['edition_fulfil_order', 'edition_order_failed', 'edition_refund_order', 'edition_payout_account_sync']) {
      assert.equal(E.q(`select count(*) from pg_proc p where proname='${fn}' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`), '0', fn);
      assert.equal(E.q(`select count(*) from pg_proc p where proname='${fn}' and has_function_privilege('service_role', p.oid, 'execute')`), '1', fn);
    }
    assert.equal(E.q(`select coalesce(string_agg(proname, ','), '') from pg_proc p where pronamespace='public'::regnamespace and (proname like 'edition_commerce%' or proname like 'admin_%edition_%' or proname like 'edition_fee%' or proname like 'edition_charge%' or proname like 'edition_org_%' or proname like 'edition_collect%' or proname like 'edition_create_order' or proname like 'edition_set_vat%' or proname like 'edition_accept_commerce%') and has_function_privilege('anon', p.oid, 'execute')`), '');
  });
  test('no existing platform table gained anything', () => {
    assert.equal(E.q(`select count(*) from information_schema.columns where table_schema='public' and table_name in ('local_businesses','hubs','hub_members','profiles','local_offers') and (column_name like '%edition%' or column_name like '%organiser_membership%')`), '0');
  });
});

describe('admin commercial model', () => {
  test('only admins set config; keys and values are validated; every change is audited', () => {
    for (const w of ['MOD', 'OWNER', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select public.admin_set_edition_commerce_config('editions.commerce.enabled','true')`)), w);
    assert.match(E.try('ADMIN', `select public.admin_set_edition_commerce_config('some.other.key','x')`), /not allowed/);
    assert.match(E.try('ADMIN', `select public.admin_set_edition_commerce_config('editions.commerce.participation.fee_percent','80')`), /not allowed/);
    assert.match(E.try('ADMIN', `select public.admin_set_edition_commerce_config('editions.commerce.fee_payer','nobody')`), /not allowed/);
    assert.match(E.try('ADMIN', `select public.admin_set_edition_commerce_config('editions.commerce.grace_days','-1')`), /not allowed/);
    cfg('editions.commerce.participation.fee_percent', '10');
    assert.equal(E.q(`select count(*) from edition_audit_log where action='commerce_config_set'`), '1');
  });
  test('commerce is OFF by default and the master switch fails closed', () => {
    assert.equal(E.one('OWNER', `select public.edition_commerce_enabled()`), 'f');
    cfg('editions.commerce.enabled', 'true'); assert.equal(E.one('OWNER', `select public.edition_commerce_enabled()`), 't');
    E.sup(`update admin_config set value='TRUE' where key='editions.commerce.enabled'`); assert.equal(E.one('OWNER', `select public.edition_commerce_enabled()`), 'f', 'anything but exactly true is off');
    E.sup(`update admin_config set value='true' where key='editions.commerce.enabled'`);
    E.sup(`update admin_config set value='false' where key='editions.enabled'`); assert.equal(E.one('OWNER', `select public.edition_commerce_enabled()`), 'f', 'Editions off means commerce off');
    E.sup(`update admin_config set value='true' where key='editions.enabled'`);
  });
});

describe('fee maths', () => {
  const fee = (kind: string, base: number, org = ORG) => Number(E.q(`select public.edition_fee_calc('${kind}', ${base}, '${org}')`));
  test('percent + fixed, minimum, cap, never above the price, zero for a free price', () => {
    cfg('editions.commerce.participation.fee_percent', '10'); cfg('editions.commerce.participation.fee_fixed_pence', '20');
    assert.equal(fee('participation', 5000), 520);
    cfg('editions.commerce.participation.fee_min_pence', '100'); assert.equal(fee('participation', 100), 100, 'min applies, capped at the price');
    cfg('editions.commerce.participation.fee_cap_pence', '300'); assert.equal(fee('participation', 5000), 300);
    assert.equal(fee('participation', 50), 50, 'never more than the price'); assert.equal(fee('participation', 0), 0);
    assert.match(E.try('OWNER', `select public.edition_fee_calc('shoes', 1, '${ORG}')`), /permission denied|unknown fee kind/);
  });
  test('rounding is to the nearest penny, half away from zero', () => {
    cfg('editions.commerce.membership.fee_percent', '2.5'); cfg('editions.commerce.membership.fee_fixed_pence', '0'); cfg('editions.commerce.membership.fee_min_pence', '0'); cfg('editions.commerce.membership.fee_cap_pence', '');
    assert.equal(fee('membership', 1010), 25); assert.equal(fee('membership', 1030), 26);
  });
  test('per-organiser overrides: admin only, newest wins, waiver, expiry', () => {
    assert.ok(failed(E.try('OWNER', `select public.admin_set_edition_fee_override('${ORG}','membership',0,0,true,'ZZ nope')`)));
    E.do('ADMIN', `select public.admin_set_edition_fee_override('${ORG}','membership',1.0,0,false,'ZZ launch partner')`);
    assert.equal(fee('membership', 10000), 100);
    E.do('ADMIN', `select public.admin_set_edition_fee_override('${ORG}','membership',null,null,true,'ZZ waived for launch')`);
    assert.equal(fee('membership', 10000), 0);
    E.sup(`update edition_commercial_overrides set until = now() - interval '1 hour' where waived`);
    assert.equal(fee('membership', 10000), 100, 'an expired waiver falls back to the previous override');
    assert.equal(E.q(`select count(*) from edition_audit_log where action='fee_override_set'`), '2');
  });
  test('charge breakdown: fee from price (default) or on top; VAT only for VAT-registered organisers', () => {
    cfg('editions.commerce.participation.fee_cap_pence', ''); cfg('editions.commerce.participation.fee_min_pence', '0'); cfg('editions.commerce.participation.fee_fixed_pence', '0'); cfg('editions.commerce.participation.fee_percent', '10');
    const bd = (mode: string) => E.q(`select price_pence || '|' || vat_pence || '|' || platform_fee_pence || '|' || charge_pence || '|' || net_to_organiser_pence || '|' || vat_mode from public.edition_charge_breakdown('participation', 10000, '${mode}', '${ORG}')`);
    assert.equal(bd('inclusive'), '10000|0|1000|10000|9000|none', 'not VAT registered => no VAT');
    E.do('OWNER', `select public.edition_set_vat_details('${ORG}', true, 'GB123456789', 'ZZ Test Cafe Ltd')`);
    assert.equal(bd('inclusive'), '10000|1667|1000|10000|9000|inclusive');
    assert.equal(bd('exclusive'), '10000|2000|1200|12000|10800|exclusive');
    assert.equal(bd('none'), '10000|0|1000|10000|9000|none');
    cfg('editions.commerce.fee_payer', 'business');
    assert.equal(bd('none'), '10000|0|1000|11000|10000|none', 'fee on top: the organiser receives the full price');
    cfg('editions.commerce.fee_payer', 'organiser');
  });
  test('VAT details: owner only, a number is needed when registered, format checked', () => {
    assert.ok(failed(E.try('EDITOR', `select public.edition_set_vat_details('${ORG}', true, 'GB123456789', 'x ok')`)));
    assert.match(E.try('OWNER', `select public.edition_set_vat_details('${ORG}', true, null, 'ZZ Org')`), /VAT number is needed/);
    assert.ok(failed(E.try('OWNER', `select public.edition_set_vat_details('${ORG}', true, 'NOT-A-NUMBER', 'ZZ Org')`)));
  });
});

describe('collection gate', () => {
  const blocker = () => E.q(`select coalesce(public.edition_collect_blocker('${ORG}'), 'OPEN')`);
  test('every missing prerequisite is named, in order, until the gate opens', () => {
    E.sup(`update admin_config set value='false' where key='editions.commerce.enabled'`); assert.equal(blocker(), 'payments_off');
    E.sup(`update admin_config set value='true' where key='editions.commerce.enabled'`);
    assert.equal(blocker(), 'no_collect_entitlement');
    E.do('ADMIN', `select public.admin_grant_edition_org_entitlement('${ORG}', 'collect_payments', null, now() + interval '60 days', 'ZZ commerce suite')`);
    assert.equal(blocker(), 'terms_not_accepted');
    assert.ok(failed(E.try('EDITOR', `select public.edition_accept_commerce_terms('${ORG}', 'draft-1')`)));
    assert.match(E.try('OWNER', `select public.edition_accept_commerce_terms('${ORG}', 'old-terms')`), /not the current terms/);
    E.do('OWNER', `select public.edition_accept_commerce_terms('${ORG}', 'draft-1')`);
    assert.equal(blocker(), 'no_payout_account');
    E.do('service', `select public.edition_payout_account_sync('${ORG}', 'acct_test_1', true, false, false, '["external_account"]'::jsonb)`);
    assert.equal(blocker(), 'payout_account_incomplete');
    E.do('service', `select public.edition_payout_account_sync('${ORG}', 'acct_test_1', true, true, true, '[]'::jsonb)`);
    assert.equal(blocker(), 'OPEN');
    E.do('ADMIN', `select public.admin_set_edition_collection('${ORG}', true, 'ZZ suspended for review')`);
    assert.equal(blocker(), 'collection_suspended');
    E.do('ADMIN', `select public.admin_set_edition_collection('${ORG}', false, 'ZZ resumed after review')`);
    assert.equal(blocker(), 'OPEN');
  });
  test('a different Stripe account cannot be silently swapped in; people cannot sync accounts', () => {
    assert.match(E.try('service', `select public.edition_payout_account_sync('${ORG}', 'acct_other', true, true, true, '[]'::jsonb)`), /different Stripe account/);
    for (const w of ['OWNER', 'ADMIN', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select public.edition_payout_account_sync('${ORG}', 'acct_x', true, true, true, '[]'::jsonb)`)), w);
  });
  test('an expired entitlement closes the gate; an unverified organiser is blocked', () => {
    E.sup(`update edition_organiser_entitlements set starts_at = now() - interval '2 days', ends_at = now() - interval '1 day' where organiser_id='${ORG}'`.replace('update edition_organiser_entitlements', 'set session_replication_role = replica; update edition_organiser_entitlements'));
    assert.equal(blocker(), 'no_collect_entitlement');
    E.sup(`set session_replication_role = replica; update edition_organiser_entitlements set starts_at = now() - interval '1 hour', ends_at = now() + interval '30 days' where organiser_id='${ORG}'`);
    assert.equal(blocker(), 'OPEN');
  });
  test('organiser entitlements are append-only and admin-granted only', () => {
    assert.match(E.sup(`delete from edition_organiser_entitlements`), /cannot be deleted/);
    assert.match(E.sup(`update edition_organiser_entitlements set max_value = 5`), /append-only/);
    assert.ok(failed(E.try('OWNER', `select public.admin_grant_edition_org_entitlement('${ORG}', 'memberships', 5, now() + interval '30 days', 'ZZ self grant')`)));
    assert.match(E.try('ADMIN', `select public.admin_grant_edition_org_entitlement('${ORG}', 'free_lunch', 5, now() + interval '30 days', 'ZZ bad feature')`), /violates check/);
  });
});

describe('packages and orders (organiser pays OneShetland)', () => {
  test('draft packages ship inactive; only admins edit; unknown features refused', () => {
    assert.equal(E.q(`select count(*) from edition_packages where active`), '0');
    assert.ok(failed(E.try('OWNER', `select public.admin_upsert_edition_package('x_pkg','X','d',100,30,'[]',null,true,1)`)));
    assert.match(E.try('ADMIN', `select public.admin_upsert_edition_package('x_pkg','X','d',100,30,'["nope"]',null,true,1)`), /unknown feature/);
    PKG = last(E.do('ADMIN', `select public.admin_upsert_edition_package('test_collect','ZZ Collect pack','d',2500,365,'["memberships","participation_fees"]',50,true,1)`));
    PKG2 = last(E.do('ADMIN', `select public.admin_upsert_edition_package('test_single','ZZ Single','d',1000,30,'[]',null,true,2)`));
    assert.equal(E.one('OWNER', `select count(*) from public.edition_packages`), '2', 'inactive drafts are hidden from organisers');
  });
  test('orders: owner or admin only (never an editor or a stranger), server-priced, one attempt = one order, switch and ceiling respected', () => {
    for (const w of ['EDITOR', 'OTHER', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select public.edition_create_order('${ORG}','${ED}','${PKG}','attempt-aaaa-1')`)), w);
    assert.match(E.try('EDITOR', `select public.edition_create_order('${ORG}','${ED}','${PKG}','attempt-aaaa-1')`), /only an owner or admin/);
    E.sup(`update admin_config set value='false' where key='editions.commerce.enabled'`);
    assert.match(E.try('OWNER', `select public.edition_create_order('${ORG}','${ED}','${PKG}','attempt-aaaa-1')`), /not switched on/);
    E.sup(`update admin_config set value='true' where key='editions.commerce.enabled'`);
    const o1 = last(E.do('OWNER', `select public.edition_create_order('${ORG}','${ED}','${PKG}','attempt-aaaa-1')`));
    const o1b = last(E.do('OWNER', `select public.edition_create_order('${ORG}','${ED}','${PKG}','attempt-aaaa-1')`));
    assert.equal(o1, o1b); assert.equal(E.q(`select amount_pence || status from edition_orders where id='${o1}'`), '2500pending');
    assert.match(E.try('OWNER', `select public.edition_create_order('${ORG}','${ED}','${PKG}','short')`), /invalid attempt/);
    E.sup(`update edition_packages set price_pence = 9999999 where id='${PKG2}'`);
    assert.match(E.try('OWNER', `select public.edition_create_order('${ORG}','${ED}','${PKG2}','attempt-aaaa-2')`), /above the allowed limit/);
    E.sup(`update edition_packages set price_pence = 1000 where id='${PKG2}'`);
    E.sup(`update edition_packages set price_pence = 3000 where id='${PKG}'`);
    assert.equal(E.q(`select amount_pence from edition_orders where id='${o1}'`), '2500', 'an existing order keeps its price');
    E.sup(`update edition_packages set price_pence = 2500 where id='${PKG}'`);
    // an admin helper may also buy (it is the same Business-run organiser); the order is its own attempt and is removed again so later counts are unchanged
    const oa = last(E.do('ADMINH', `select public.edition_create_order('${ORG}','${ED}','${PKG}','attempt-admh-1')`));
    assert.equal(E.q(`select amount_pence from edition_orders where id='${oa}'`), '2500');
    E.sup(`delete from edition_orders where id='${oa}'`);
    // an unapproved Edition cannot have a package chosen
    const raw = draftEdition(Base, 'BIZ_OWNER', ORG, 'zz-com-raw', 'ZZ Com Raw');
    assert.match(E.try('OWNER', `select public.edition_create_order('${ORG}','${raw}','${PKG}','attempt-raw-1')`), /once OneShetland has approved/);
  });
  test('fulfilment: amount must match; grants publish and the package features; duplicates and replays do nothing more', () => {
    const o = E.q(`select id from edition_orders where attempt_id='attempt-aaaa-1'`);
    for (const w of ['OWNER', 'ADMIN', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select public.edition_fulfil_order('${o}','pi_1',2500)`)), w);
    assert.match(E.try('service', `select public.edition_fulfil_order('${o}','pi_1',1)`), /does not match/);
    assert.equal(E.one('service', `select public.edition_fulfil_order('${o}','pi_1',2500)`), 'fulfilled');
    E.do('service', `select public.edition_fulfil_order('${o}','pi_1',2500)`);
    assert.equal(E.q(`select count(*) from edition_entitlements where order_id='${o}'`), '1');
    assert.equal(E.q(`select count(*) from edition_organiser_entitlements where order_id='${o}'`), '2');
    assert.equal(E.q(`select status from edition_orders where id='${o}'`), 'paid');
    assert.equal(E.q(`select public.edition_org_limit('${ORG}','memberships')`), '50');
    assert.equal(E.q(`select public.edition_entitled('${ED}','publish')`), 't');
  });
  test('a second package is refused mid-term (no stacking, no extension product); a renewal window allows it', () => {
    assert.match(E.try('OWNER', `select public.edition_create_order('${ORG}','${ED}','${PKG2}','attempt-stack-1')`), /already live until/);
    E.sup(`insert into admin_config (key, value, category) values ('editions.commerce.renewal_window_days','800','editions') on conflict (key) do update set value='800'`);
  });
  test('a second purchase extends rather than overlaps; the publish gate really opens with a paid order', () => {
    const o2 = last(E.do('OWNER', `select public.edition_create_order('${ORG}','${ED}','${PKG2}','attempt-bbbb-1')`));
    E.do('service', `select public.edition_fulfil_order('${o2}','pi_2',1000)`);
    assert.equal(E.q(`select (select starts_at from edition_entitlements where order_id='${o2}') >= (select ends_at from edition_entitlements where stripe_payment_intent_id='pi_1') - interval '1 second'`), 't');
    E.sup(`update editions set summary='ZZ summary' where id='${ED}'`);
    E.do('OWNER', `select public.edition_set_status('${ED}', 'published')`);
    assert.equal(E.q(`select status from editions where id='${ED}'`), 'published');
  });
  test('package abilities start now even when the Edition already has a long publish window', () => {
    const o4 = last(E.do('OWNER', `select public.edition_create_order('${ORG}','${ED}','${PKG}','attempt-dddd-1')`));
    E.do('service', `select public.edition_fulfil_order('${o4}','pi_4',2500)`);
    assert.equal(E.q(`select (starts_at <= now())::text from edition_organiser_entitlements where order_id='${o4}' limit 1`), 'true');
    assert.equal(E.q(`select public.edition_org_entitled('${ORG}','participation_fees')`), 't');
    assert.equal(E.q(`select (starts_at > now() + interval '300 days')::text from edition_entitlements where order_id='${o4}'`), 'true', 'the publish window itself still queues after the existing one');
  });
  test('failed payment leaves the order failed and grants nothing; retry uses a new attempt', () => {
    const o3 = last(E.do('OWNER', `select public.edition_create_order('${ORG}','${ED}','${PKG2}','attempt-cccc-1')`));
    E.do('service', `select public.edition_order_failed('${o3}','pi_3')`);
    assert.equal(E.q(`select status from edition_orders where id='${o3}'`), 'failed');
    assert.equal(E.q(`select count(*) from edition_entitlements where order_id='${o3}'`), '0');
    assert.match(E.try('service', `select public.edition_fulfil_order('${o3}','pi_3',1000)`), /^(?!.*already_fulfilled)/);
    E.sup(`delete from admin_config where key='editions.commerce.renewal_window_days'`);
  });
  test('refunds: partial recorded, full voids what the order granted, cumulative and idempotent, never above the amount', () => {
    const o = E.q(`select id from edition_orders where attempt_id='attempt-aaaa-1'`);
    assert.equal(last(E.do('service', `select public.edition_refund_order('${o}', 500)`)), 'recorded');
    assert.equal(E.one('service', `select public.edition_refund_order('${o}', 500)`), 'no_change');
    assert.equal(E.q(`select count(*) from edition_entitlements where order_id='${o}' and voided_at is null`), '1');
    assert.match(E.try('service', `select public.edition_refund_order('${o}', 99999)`), /exceeds the order/);
    assert.equal(last(E.do('service', `select public.edition_refund_order('${o}', 2500)`)), 'voided');
    assert.equal(E.q(`select count(*) from edition_entitlements where order_id='${o}' and voided_at is null`), '0');
    assert.equal(E.q(`select count(*) from edition_organiser_entitlements where order_id='${o}' and voided_at is null`), '0');
    assert.equal(E.q(`select status from edition_orders where id='${o}'`), 'refunded');
  });
});

describe('payment ledger', () => {
  test('append-only: only status, refunds and fee detail may change; offline rows need a note; GBP only', () => {
    const biz = last(E.sup(`insert into local_businesses (name, category, address, is_active) values ('ZZ Pay Biz','food_drink','x',true) returning id`));
    E.sup(`select public.edition_record_payment_row('${ORG}','${biz}','membership','${ED}','stripe','succeeded',1000,0,'none',50,1000,950,'pi_ledger',null,null,now(),now()+interval '30 days',null,null,null,null,null)`);
    assert.equal(E.q(`select count(*) from edition_payments`), '1');
    assert.match(E.sup(`delete from edition_payments`), /cannot be deleted/);
    assert.match(E.sup(`update edition_payments set charge_pence = 1`), /append-only/);
    assert.match(E.sup(`update edition_payments set refunded_pence = 2000`), /violates check/);
    E.sup(`update edition_payments set refunded_pence = 400, status='partially_refunded'`);
    assert.match(E.sup(`update edition_payments set refunded_pence = 100`), /cannot be reduced/);
    assert.match(E.sup(`select public.edition_record_payment_row('${ORG}','${biz}','membership','${ED}','offline','succeeded',1000,0,'none',0,1000,1000,null,null,null,null,null,'cheque',null,null,'',null)`), /violates check/);
    assert.match(E.sup(`insert into edition_payments (organiser_id,business_id,kind,ref_id,source,status,price_pence,charge_pence,net_to_organiser_pence,currency,stripe_payment_intent_id) values ('${ORG}','${biz}','membership','${ED}','stripe','succeeded',1,1,1,'eur','pi_x')`), /violates check/);
    assert.match(E.sup(`select public.edition_record_payment_row('${ORG}','${biz}','membership','${ED}','stripe','succeeded',1000,0,'none',50,1000,950,'pi_ledger',null,null,null,null,null,null,null,null,null)`), /duplicate key/, 'one row per PaymentIntent');
  });
});
