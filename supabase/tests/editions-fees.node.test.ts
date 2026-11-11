/**
 * editions-fees.node.test.ts — ISOLATED Postgres only. The Editions FEE MODEL and financial safeguards (migration 20270105000000): commission 2%, estimated processing fee recovered inside the
 * application fee (never added to the customer), ledger parts, actual-fee tolerance and variance, refunds (customer refund then commission share), disputes (record, recovery, insufficient balance),
 * reconciliation, statements, variance report, VAT readiness. Provider events are simulated through the service-role functions; the Stripe calls themselves are proved by the pure tests and stripe-mock.
 * Run: ISOLATED_ONLY=editions-fees npm run test:isolated
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Env, USERS, seed, enter, draftEdition, d, last, failed as baseFailed } from './_support/editions-env.ts';
import { publishEdition, aliased } from './_support/editions-env-2.ts';
import * as C from '../functions/_shared/editions-commerce-core.ts';

const MAP = { ADMIN: 'ADMIN', OWNER: 'BIZ_OWNER', BIZ1: 'BIZ2_OWNER', BIZ2: 'HUB2_OWNER', STRANGER: 'STRANGER' } as const;
const U = { BIZ1: USERS.BIZ2_OWNER, BIZ2: USERS.HUB2_OWNER, STRANGER: USERS.STRANGER } as const;
type Who = keyof typeof MAP | 'anon' | 'service';
const failed = baseFailed;
let Base: Env, S: ReturnType<typeof seed>;
let E: ReturnType<typeof aliased<keyof typeof MAP>>;
let ORG = '', ED = '', B1 = '', B2 = '', L1 = '', L2 = '', T_M = '';
const days = (n: number) => `(now() + interval '${n} days')`;
const cfg = (k: string, v: string) => E.do('ADMIN', `select public.admin_set_edition_commerce_config('${k}', '${v}')`);
const row = (sql: string) => E.q(sql);
const A = (sql: string) => E.one('ADMIN', sql);   // read models that need an administrator
const CFG: C.FeeConfig = { commission_percent: 2, commission_fixed_pence: 0, commission_min_pence: 0, commission_cap_pence: null, stripe_cost_percent: 1.5, stripe_cost_fixed_pence: 20 };
const pay = (pi: string) => row(`select id from edition_payments where stripe_payment_intent_id='${pi}' or stripe_invoice_id='${pi}'`);
const pp = (pi: string, cols: string) => row(`select ${cols} from edition_payments where stripe_payment_intent_id='${pi}' or stripe_invoice_id='${pi}'`);
const exc = (kind: string, ref = '') => row(`select count(*) from edition_reconciliation_exceptions where kind='${kind}'${ref ? ` and provider_ref like '${ref}%'` : ''}`);
const succeedP = (link: string, pi: string, charge: number, stripeFee: string, appFee: string) => E.doOne('service', `select public.edition_participation_payment_succeeded('${link}', '${pi}', 'ch_${pi}', ${charge}, ${stripeFee}, ${appFee})`);
const memSucceed = (m: string, inv: string, charge: number, stripeFee: string, appFee: string) => E.doOne('service', `select public.edition_membership_payment_succeeded('${m}', 'sub_${m.slice(0, 8)}', 'pi_${inv}', '${inv}', 'ch_${inv}', now(), ${days(30)}, ${charge}, ${stripeFee}, ${appFee})`);
const newMember = (owner: Who, name: string) => {
  const b = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${USERS[MAP[owner as keyof typeof MAP]]}', '${name}', 'retail', 'x', true) returning id`));
  return last(E.do(owner, `select public.edition_membership_apply('${T_M}', '${b}', 'monthly')`));
};

before(() => {
  Base = new Env('editionsfees');
  S = seed(Base); E = aliased(Base, MAP);
  E.sup(`insert into admin_config (key, value, category) values ('editions.commerce.enabled','true','editions') on conflict (key) do update set value = excluded.value;`);
  ORG = enter(Base, 'BIZ_OWNER', 'business', S.BIZ);
  for (const f of ['collect_payments', 'memberships', 'offline_records', 'participation_fees']) E.do('ADMIN', `select public.admin_grant_edition_org_entitlement('${ORG}', '${f}', null, ${days(90)}, 'ZZ fee suite')`);
  E.do('OWNER', `select public.edition_accept_commerce_terms('${ORG}', 'draft-1')`);
  E.do('service', `select public.edition_payout_account_sync('${ORG}', 'acct_fee_1', true, true, true, '[]'::jsonb)`);
  ED = draftEdition(Base, 'BIZ_OWNER', ORG, 'zz-fee-fest', 'ZZ Fee Fest');
  publishEdition(Base, 'BIZ_OWNER', ED, 'ZZ fee suite');
  const biz = (o: string, n: string) => last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active, subscription_tier, subscription_until) values ('${o}', '${n}', 'food_drink', 'x', true, 'pro', now() + interval '90 days') returning id`));
  B1 = biz(U.BIZ1, 'ZZ Fee Cafe'); B2 = biz(U.BIZ2, 'ZZ Fee Bakery');
  const link = (b: string, u: Who) => { const l = last(E.do('OWNER', `select public.edition_invite_partner('${ED}','business','${b}')`)); E.do(u, `select public.edition_link_act('${l}','approve',null)`); return l; };
  L1 = link(B1, 'BIZ1'); L2 = link(B2, 'BIZ2');
  E.do('OWNER', `select public.edition_set_participation_terms('${ED}', 'fee_required', 2000, 'none', 'full', null, null, null)`);
  T_M = last(E.do('OWNER', `select public.edition_tier_save('${ORG}', null, 'ZZ Fee Friend', 'd', '[]'::jsonb, 1000, null, false, 'none', 'open', 'none', null, null, 1)`));
});
after(() => Base?.drop());

describe('configuration and lockdown', () => {
  test('commission defaults to 2 for both kinds; the estimate rates are placeholders, flagged unconfirmed; fee_payer is organiser only', () => {
    assert.equal(row(`select public.edition_commerce_cfg('editions.commerce.participation.fee_percent','x') || '|' || public.edition_commerce_cfg('editions.commerce.membership.fee_percent','x')`), '2|2');
    assert.equal(row(`select public.edition_commerce_cfg('editions.commerce.participation.stripe_cost_percent','x') || '|' || public.edition_commerce_cfg('editions.commerce.participation.stripe_cost_fixed_pence','x') || '|' || public.edition_commerce_cfg('editions.commerce.stripe_cost_confirmed','x')`), '1.5|20|false');
    assert.equal(row(`select public.edition_commerce_cfg('platform.vat_registered','x')`), 'false');
    assert.match(E.try('ADMIN', `select public.admin_set_edition_commerce_config('editions.commerce.fee_payer','business')`), /not allowed/);
    assert.ok(!failed(E.try('ADMIN', `select public.admin_set_edition_commerce_config('editions.commerce.fee_payer','organiser')`)));
  });
  test('validators: estimate rates, variance alert, tolerance, dispute commission switch, VAT flag; non-admins refused', () => {
    for (const [k, v] of [['editions.commerce.membership.stripe_cost_percent', '11'], ['editions.commerce.membership.stripe_cost_percent', 'x'], ['editions.commerce.participation.stripe_cost_fixed_pence', '1000'], ['editions.commerce.variance_alert_pence', '-1'],
      ['editions.commerce.fee_tolerance_pence', '99'], ['editions.commerce.refund_commission_on_dispute', 'maybe'], ['platform.vat_registered', 'yes'], ['editions.commerce.stripe_cost_confirmed', '1']]) assert.match(E.try('ADMIN', `select public.admin_set_edition_commerce_config('${k}','${v}')`), /not allowed/, `${k}=${v}`);
    for (const [k, v] of [['editions.commerce.membership.stripe_cost_percent', '1.5'], ['editions.commerce.variance_alert_pence', '20'], ['editions.commerce.fee_tolerance_pence', '1'], ['editions.commerce.refund_commission_on_dispute', 'false'], ['platform.vat_registered', 'false']]) assert.ok(!failed(E.try('ADMIN', `select public.admin_set_edition_commerce_config('${k}','${v}')`)), `${k}=${v}`);
    assert.ok(failed(E.try('OWNER', `select public.admin_set_edition_commerce_config('editions.commerce.variance_alert_pence','30')`)));
  });
  test('money-in, worker and fee functions are not executable by people or anon; the new reports are admin-only', () => {
    for (const fn of ['edition_dispute_event', 'edition_dispute_recoveries_next', 'edition_dispute_recovery_mark', 'edition_dispute_commission_next', 'edition_dispute_commission_mark', 'edition_commission_plan_pending', 'edition_commission_refunds_next', 'edition_commission_refund_mark',
      'edition_payment_note_stripe_fee', 'edition_payment_note_app_fee', 'edition_participation_payment_succeeded', 'edition_membership_payment_succeeded', 'edition_reconcile_apply', 'edition_fee_parts', 'edition_fee_calc', 'edition_refund_request_before', 'edition_payments_parts_default'])
      assert.equal(row(`select count(*) from pg_proc p where proname='${fn}' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`), '0', fn);
    for (const fn of ['edition_dispute_event', 'edition_commission_refunds_next', 'edition_dispute_recoveries_next']) assert.equal(row(`select count(*) from pg_proc p where proname='${fn}' and has_function_privilege('service_role', p.oid, 'execute')`), '1', fn);
    for (const w of ['OWNER', 'BIZ1', 'STRANGER', 'anon'] as Who[]) {
      assert.ok(failed(E.try(w, `select * from public.admin_edition_variance_report(now() - interval '1 year', now() + interval '1 day', 'month')`)), w);
      assert.ok(failed(E.try(w, `select * from public.admin_edition_fee_statement(now() - interval '1 year', now() + interval '1 day')`)), w);
      assert.ok(failed(E.try(w, `select * from public.admin_edition_variance_items(now() - interval '1 year', now() + interval '1 day')`)), w);
    }
    assert.equal(row(`select count(*) from pg_class where relname='edition_dispute_recoveries' and not relrowsecurity`), '0');
    assert.equal(row(`select count(*) from pg_policies where tablename='edition_dispute_recoveries' and cmd='ALL'`), '0');
    assert.equal(row(`select count(*) from information_schema.role_table_grants where table_name='edition_dispute_recoveries' and grantee in ('anon','authenticated') and (grantee='anon' or privilege_type <> 'SELECT')`), '0');
  });
  test('overrides: the recovery waiver is admin-set and audited; a waiver zeroes the commission only', () => {
    assert.ok(failed(E.try('OWNER', `select public.admin_set_edition_fee_override('${ORG}','participation',null,null,true,'ZZ nope',null,true)`)));
    try {
    E.do('ADMIN', `select public.admin_set_edition_fee_override('${ORG}','participation',null,null,true,'ZZ launch partner waiver')`);
    assert.equal(row(`select out_commission || '|' || out_recovery || '|' || out_fee from public.edition_fee_parts('participation', 2000, '${ORG}')`), '0|50|50', 'commission waived, processing cost still recovered');
    E.do('ADMIN', `select public.admin_set_edition_fee_override('${ORG}','participation',null,null,true,'ZZ explicit recovery waiver',null,true)`);
    assert.equal(row(`select out_fee from public.edition_fee_parts('participation', 2000, '${ORG}')`), '0');
    assert.equal(row(`select count(*) from edition_audit_log where action='fee_override_set' and detail->>'recovery_waived'='true'`), '1');
    } finally { E.sup(`delete from edition_commercial_overrides`); }
  });
});

describe('edition_commission_rates: the standard published rates for organisers', () => {
  const rates = (w: Who) => E.one(w, `select string_agg(kind || ':' || percent || ':' || fixed_pence || ':' || min_pence || ':' || coalesce(cap_pence::text, 'none'), ',' order by kind) from public.edition_commission_rates()`);
  test('shape: exactly two rows (membership, participation) with five columns; any signed-in user can read; anon cannot', () => {
    assert.equal(rates('OWNER'), 'membership:2:0:0:none,participation:2:0:0:none'); assert.equal(rates('STRANGER'), 'membership:2:0:0:none,participation:2:0:0:none');
    assert.equal(row(`select string_agg(parameter_name, ',' order by ordinal_position) from information_schema.parameters where specific_name like 'edition_commission_rates%' and parameter_mode='OUT'`), 'kind,percent,fixed_pence,min_pence,cap_pence');
    assert.ok(failed(E.try('anon', `select * from public.edition_commission_rates()`)));
    assert.equal(row(`select has_function_privilege('anon', 'public.edition_commission_rates()', 'execute') or has_function_privilege('public', 'public.edition_commission_rates()', 'execute')`), 'f');
    assert.equal(row(`select has_function_privilege('authenticated', 'public.edition_commission_rates()', 'execute') and prosecdef and exists (select 1 from unnest(proconfig) c where c like 'search_path=%') from pg_proc where proname='edition_commission_rates'`), 't');
  });
  test('values follow the live configuration; a per-organiser override is NOT applied; nothing else from configuration is exposed', () => {
    cfg('editions.commerce.membership.fee_percent', '3.5'); cfg('editions.commerce.membership.fee_fixed_pence', '10'); cfg('editions.commerce.membership.fee_min_pence', '25'); cfg('editions.commerce.membership.fee_cap_pence', '900');
    try {
      E.do('ADMIN', `select public.admin_set_edition_fee_override('${ORG}','membership',0,0,true,'ZZ rates explainer check')`);
      assert.equal(rates('OWNER'), 'membership:3.5:10:25:900,participation:2:0:0:none', 'the waiver on this organiser is not reflected');
      assert.doesNotMatch(rates('OWNER'), /1\.5|20p|stripe/i, 'the processing-cost estimate rates are not exposed');
    } finally { E.sup(`delete from edition_commercial_overrides`); for (const [k, v] of [['fee_percent', '2'], ['fee_fixed_pence', '0'], ['fee_min_pence', '0'], ['fee_cap_pence', '']]) cfg(`editions.commerce.membership.${k}`, v); }
    assert.equal(rates('OWNER'), 'membership:2:0:0:none,participation:2:0:0:none');
  });
});

describe('fee maths: the database equals the pure functions; nothing is ever added to the customer', () => {
  const sqlParts = (kind: string, lo: number, hi: number) => row(`select string_agg(c || ':' || p.out_commission || ':' || p.out_recovery || ':' || p.out_fee || ':' || p.out_reduced, ',' order by c) from generate_series(${lo}, ${hi}) c, lateral public.edition_fee_parts('${kind}', c, '${ORG}') p`);
  const same = (a: string, b: string, what: string) => { if (a === b) return; const x = a.split(','), y = b.split(','); const i = x.findIndex((v, k) => v !== y[k]); assert.fail(`${what}: first difference at ${i}: sql ${x[i]} vs ts ${y[i]} (lengths ${x.length}/${y.length})`); };
  const tsParts = (lo: number, hi: number, cfg: C.FeeConfig) => { const o: string[] = []; for (let c = lo; c <= hi; c++) { const f = C.feeParts(c, cfg); o.push(`${c}:${f.commission}:${f.recovery}:${f.fee}:${f.recovery_reduced ? 'true' : 'false'}`); } return o.join(','); };
  test('default rates over every amount from 1p to 6000p and a spread of larger ones', () => {
    same(sqlParts('participation', 1, 6000), tsParts(1, 6000, CFG), 'participation');
    same(sqlParts('membership', 99990, 100010), tsParts(99990, 100010, CFG), 'membership 1000');
    same(sqlParts('membership', 499990, 500000), tsParts(499990, 500000, CFG), 'membership 5000');
  });
  test('min, cap, fixed and different estimate rates agree too; F never exceeds C', () => {
    try {
    cfg('editions.commerce.participation.fee_fixed_pence', '7'); cfg('editions.commerce.participation.fee_min_pence', '30'); cfg('editions.commerce.participation.fee_cap_pence', '400'); cfg('editions.commerce.participation.stripe_cost_percent', '2.35'); cfg('editions.commerce.participation.stripe_cost_fixed_pence', '31');
    const c2: C.FeeConfig = { commission_percent: 2, commission_fixed_pence: 7, commission_min_pence: 30, commission_cap_pence: 400, stripe_cost_percent: 2.35, stripe_cost_fixed_pence: 31 };
    same(sqlParts('participation', 1, 3000), tsParts(1, 3000, c2), 'custom');
    assert.equal(row(`select count(*) from generate_series(1, 5000) c, lateral public.edition_fee_parts('participation', c, '${ORG}') p where p.out_fee > c or p.out_fee <> p.out_commission + p.out_recovery`), '0');
    } finally { for (const [k, v] of [['fee_fixed_pence', '0'], ['fee_min_pence', '0'], ['fee_cap_pence', ''], ['stripe_cost_percent', '1.5'], ['stripe_cost_fixed_pence', '20']]) cfg(`editions.commerce.participation.${k}`, v); }
  });
  test('the reduction rule is recorded: a tiny charge gives up recovery first', () => {
    assert.equal(row(`select out_commission || '|' || out_recovery || '|' || out_fee || '|' || out_reduced from public.edition_fee_parts('participation', 15, '${ORG}')`), '0|15|15|true');
  });
  test('breakdown: the customer pays exactly the price (VAT as before), the organiser keeps price minus F; a VAT-registered organiser is unchanged for the customer', () => {
    const bd = (mode: string) => row(`select price_pence || '|' || vat_pence || '|' || platform_fee_pence || '|' || charge_pence || '|' || net_to_organiser_pence || '|' || vat_mode || '|' || fee_payer || '|' || commission_pence || '|' || recovery_estimate_pence from public.edition_charge_breakdown('participation', 10000, '${mode}', '${ORG}')`);
    assert.equal(bd('inclusive'), '10000|0|370|10000|9630|none|organiser|200|170');
    E.do('OWNER', `select public.edition_set_vat_details('${ORG}', true, 'GB123456789', 'ZZ Fee Cafe Ltd')`);
    assert.equal(bd('inclusive'), '10000|1667|370|10000|9630|inclusive|organiser|200|170', 'inclusive: same charge');
    assert.equal(bd('exclusive'), '10000|2000|440|12000|11560|exclusive|organiser|240|200', 'exclusive: price + VAT as before; the fee is taken from it, never added');
    E.sup(`update admin_config set value='business' where key='editions.commerce.fee_payer'`);
    assert.equal(bd('inclusive'), '10000|1667|370|10000|9630|inclusive|organiser|200|170', 'a stored legacy business payer changes nothing');
    E.sup(`update admin_config set value='organiser' where key='editions.commerce.fee_payer'`);
    E.do('OWNER', `select public.edition_set_vat_details('${ORG}', false, null, null)`);
    assert.equal(row(`select count(*) from information_schema.columns where table_name='edition_charge_breakdown' or (table_name='edition_orders' and column_name='fee_payer')`), '0');
  });
});

describe('participation payments: parts, actual fee, variance', () => {
  test('success records commission, estimate, actual application fee and Stripe fee; variance = estimate minus actual; within the alert no exception', () => {
    E.do('BIZ1', `select public.edition_participation_pay_prepare('${L1}', 'attempt-f-0001')`);
    assert.equal(succeedP(L1, 'pi_f1', 2000, '40', '90'), 'recorded');
    assert.equal(pp('pi_f1', `platform_fee_pence || '|' || net_to_organiser_pence || '|' || commission_pence || '|' || recovery_estimate_pence || '|' || application_fee_actual_pence || '|' || stripe_fee_pence || '|' || recovery_variance_pence || '|' || stripe_fee_refunded_pence`), '90|1910|40|50|90|40|10|0');
    assert.equal(exc('fee_variance'), '0'); assert.equal(exc('fee_mismatch'), '0');
  });
  test('replay and duplicates change nothing', () => {
    assert.equal(succeedP(L1, 'pi_f1', 2000, '40', '90'), 'already_recorded');
    assert.equal(row(`select count(*) from edition_payments where kind='participation'`), '1');
  });
  test('a large variance raises fee_variance once; a collected fee beyond tolerance raises fee_mismatch', () => {
    E.do('BIZ2', `select public.edition_participation_pay_prepare('${L2}', 'attempt-f-0002')`);
    E.do('BIZ2', `select 1`);
    assert.equal(succeedP(L2, 'pi_f2', 2000, '95', '88'), 'recorded');
    assert.equal(pp('pi_f2', `recovery_variance_pence || '|' || application_fee_actual_pence`), '-45|88');
    assert.equal(exc('fee_variance', 'pi_f2'), '1'); assert.equal(exc('fee_mismatch', 'pi_f2'), '1', '88 vs expected 90 is 2p: beyond the 1p tolerance');
    assert.equal(row(`select detail->>'estimate' || '|' || (detail->>'actual_stripe_fee') || '|' || (detail->>'variance') from edition_reconciliation_exceptions where kind='fee_variance' and provider_ref='pi_f2'`), '50|95|-45');
  });
  test('a failed payment moves no money: no ledger row, no fee, no exception; the participation stays unpaid', () => {
    const before = row(`select count(*) from edition_payments`);
    E.do('service', `select public.edition_participation_payment_failed('${L1}', 'pi_failed')`);
    assert.equal(row(`select count(*) from edition_payments`), before); assert.equal(exc('fee_variance'), '1');
  });
});

describe('membership invoices: percentage conversion, tolerance, rounding variants, renewals, failures', () => {
  let M = '';
  test('prepare shows the fee; the first invoice records the ACTUAL application fee read from the charge, with parts that add up', () => {
    M = newMember('BIZ1', 'ZZ Fee Member A');
    const prep = JSON.parse(E.one('BIZ1', `select public.edition_membership_pay_prepare('${M}', 'attempt-m-0001')::text`));
    assert.equal(prep.charge_pence, 1000); assert.equal(prep.platform_fee_pence, 55); assert.equal(prep.net_to_organiser_pence, 945);
    assert.equal(C.feePercent(prep.platform_fee_pence, prep.charge_pence), 5.5, 'the subscription percentage Stripe will be given');
    assert.equal(memSucceed(M, 'in_m1', 1000, '36', '55'), 'recorded');
    assert.equal(pp('in_m1', `platform_fee_pence || '|' || commission_pence || '|' || recovery_estimate_pence || '|' || application_fee_actual_pence || '|' || recovery_variance_pence`), '55|20|35|55|-1');
  });
  test('a renewal is a second invoice, recorded the same way; a replay changes nothing', () => {
    assert.equal(memSucceed(M, 'in_m2', 1000, '36', '55'), 'recorded');
    assert.equal(memSucceed(M, 'in_m2', 1000, '36', '55'), 'already_recorded');
    assert.equal(row(`select count(*) from edition_payments where ref_id='${M}'`), '2');
  });
  test('rounding variants: whatever Stripe does with the percentage (floor, nearest, ceiling) the fee lands within the 1p tolerance and is recorded as the actual', () => {
    cfg('editions.commerce.membership.fee_tolerance', '1');
    let i = 0;
    for (const mode of ['floor', 'nearest', 'ceil'] as const) {
      const f = C.feeParts(1000, CFG).fee, collected = C.stripePercentFee(1000, C.feePercent(f, 1000), mode); i++;
      assert.ok(Math.abs(collected - f) <= 1);
      memSucceed(M, `in_r${i}`, 1000, '36', String(collected));
      assert.equal(pp(`in_r${i}`, `platform_fee_pence || '|' || application_fee_actual_pence`), `${collected}|${collected}`);
    }
    assert.equal(exc('fee_mismatch', 'in_r'), '0', 'no exception for rounding inside tolerance');
    memSucceed(M, 'in_off1', 1000, '36', '56'); assert.equal(exc('fee_mismatch', 'in_off1'), '0', '+1p is inside the tolerance');
    memSucceed(M, 'in_off2', 1000, '36', '57'); assert.equal(exc('fee_mismatch', 'in_off2'), '1', '+2p is beyond it');
    assert.equal(row(`select detail->>'provider' || '|' || (detail->>'computed') || '|' || (detail->>'tolerance') from edition_reconciliation_exceptions where provider_ref='in_off2' and kind='fee_mismatch'`), '57|55|1');
    assert.equal(pp('in_off2', `commission_pence || '|' || recovery_estimate_pence`), '20|37', 'parts always sum to the recorded fee: the residue sits in the estimate');
  });
  test('the tolerance is configurable', () => {
    cfg('editions.commerce.fee_tolerance_pence', '3'); memSucceed(M, 'in_tol', 1000, '36', '58'); assert.equal(exc('fee_mismatch', 'in_tol'), '0'); cfg('editions.commerce.fee_tolerance_pence', '1');
  });
  test('an invoice for a different amount (proration, coupon, tier change) is refused and nothing is recorded; no ledger row, no fee', () => {
    const n = row(`select count(*) from edition_payments`);
    assert.match(E.try('service', `select public.edition_membership_payment_succeeded('${M}', 'sub_x', 'pi_x', 'in_x', 'ch_x', now(), ${days(30)}, 500, 20, 28)`), /does not match the membership price/);
    assert.equal(row(`select count(*) from edition_payments`), n);
  });
  test('failed renewals: no ledger row and no fee; the membership goes past due and follows the existing grace rule', () => {
    const n = row(`select count(*) from edition_payments`);
    E.do('service', `select public.edition_membership_payment_failed('${M}', 'in_fail', 1)`);
    assert.equal(row(`select status from organiser_memberships where id='${M}'`), 'past_due'); assert.equal(row(`select count(*) from edition_payments`), n);
    E.sup(`update organiser_memberships set past_due_since = now() - interval '20 days' where id='${M}'`);
    E.do('service', `select public.edition_membership_sweep()`);
    assert.equal(row(`select status from organiser_memberships where id='${M}'`), 'expired');
  });
});

describe('refunds: customer refund, then ONLY the commission share; idempotent; cumulative', () => {
  let P = '', REQ1 = '';
  const planAndNext = () => { E.do('service', `select public.edition_commission_plan_pending()`); return row(`select coalesce(string_agg(amount_pence::text, ','), '') from (select * from public.edition_commission_refunds_next()) x`); };
  test('request, step 1 (exact provider parameters), webhook confirmation, step 2 amount = round(commission x R / C)', () => {
    P = pay('pi_f1');
    for (const w of ['OWNER', 'ADMIN'] as Who[]) assert.ok(!failed(E.try(w, `select public.edition_payment_request_refund('${P}', 800, 'Goodwill refund')`)), w);
    REQ1 = last(E.do('OWNER', `select public.edition_payment_request_refund('${P}', 800, 'Goodwill refund')`));
    const n = row(`select request_id || '|' || amount_pence || '|' || stripe_payment_intent_id from public.edition_refunds_next()`);
    assert.match(n, /\|800\|pi_f1$/);
    assert.deepEqual(C.refundParams({ payment_intent: 'pi_f1', amount_pence: 800, request_id: REQ1 }), { payment_intent: 'pi_f1', amount: '800', reverse_transfer: 'true', refund_application_fee: 'false', 'metadata[kind]': 'edition_refund', 'metadata[request_id]': REQ1 });
    assert.equal(row(`select refunded_before_pence from edition_refund_requests where id='${REQ1}'`), '0', 'the ledger total before the request is captured at creation');
    assert.equal(planAndNext(), '', 'nothing to plan until the provider has accepted the customer refund');
    E.do('service', `select public.edition_refund_request_mark('${REQ1}', 'submitted', null)`);
    assert.equal(planAndNext(), '16', '40 x 800 / 2000');
    const q = C.applicationFeeRefundRequest({ application_fee_id: 'fee_1', amount_pence: 16, request_id: REQ1 });
    assert.deepEqual([q.path, q.params.amount, q.idempotencyKey], ['/application_fees/fee_1/refunds', '16', `ed-feerefund-${REQ1}-16`]);
    assert.equal(planAndNext(), '16', 'planning twice is a no-op');
  });
  test('the ledger advances once on success; a repeat or duplicate webhook changes nothing', () => {
    E.do('service', `select public.edition_commission_refund_mark('${REQ1}', 'done', null)`); E.do('service', `select public.edition_commission_refund_mark('${REQ1}', 'done', null)`);
    assert.equal(pp('pi_f1', 'commission_refunded_pence'), '16');
    assert.equal(last(E.do('service', `select public.edition_payment_refunded('pi_f1', 800)`)), 'partially_refunded');
    assert.equal(last(E.do('service', `select public.edition_payment_refunded('pi_f1', 800)`)), 'no_change');
    assert.equal(pp('pi_f1', 'commission_refunded_pence'), '16'); assert.equal(planAndNext(), '');
    assert.equal(row(`select status || '|' || commission_refund_status from edition_refund_requests where id='${REQ1}'`), 'done|done');
  });
  test('a second partial refund returns only the increase; a full refund ends exactly at the whole commission', () => {
    const r2 = last(E.do('OWNER', `select public.edition_payment_request_refund('${P}', 700, 'Second partial')`));
    assert.equal(row(`select refunded_before_pence from edition_refund_requests where id='${r2}'`), '800');
    E.do('service', `select public.edition_refund_request_mark('${r2}', 'submitted', null)`);
    assert.equal(planAndNext(), '14', 'cumulative 1500: 30 returned in total, 16 already');
    E.do('service', `select public.edition_commission_refund_mark('${r2}', 'done', null)`);
    E.do('service', `select public.edition_payment_refunded('pi_f1', 1500)`);
    const r3 = last(E.do('OWNER', `select public.edition_payment_request_refund('${P}', 500, 'Remainder')`));
    E.do('service', `select public.edition_refund_request_mark('${r3}', 'submitted', null)`);
    assert.equal(planAndNext(), '10');
    E.do('service', `select public.edition_commission_refund_mark('${r3}', 'done', null)`);
    E.do('service', `select public.edition_payment_refunded('pi_f1', 2000)`);
    assert.equal(pp('pi_f1', `status || '|' || refunded_pence || '|' || commission_refunded_pence || '|' || stripe_fee_refunded_pence`), 'refunded|2000|40|0');
  });
  test('a fully refunded payment cannot be refunded again; one in flight blocks another', () => {
    assert.match(E.try('OWNER', `select public.edition_payment_request_refund('${P}', 100, 'Again please')`), /cannot be refunded/);
    const P2 = pay('pi_f2'); const ra = last(E.do('OWNER', `select public.edition_payment_request_refund('${P2}', 500, 'First')`));
    assert.match(E.try('OWNER', `select public.edition_payment_request_refund('${P2}', 100, 'Second at once')`), /already in progress/);
    E.do('service', `select public.edition_refund_request_mark('${ra}', 'submitted', null)`); E.do('service', `select public.edition_commission_plan_pending()`);
    assert.equal(row(`select commission_refund_pence from edition_refund_requests where id='${ra}'`), '10', '40 x 500 / 2000');
  });
  test('step 2 retries with back-off, then fails once with an exception; the customer refund is never repeated', () => {
    const ra = row(`select id from edition_refund_requests where commission_refund_status='pending'`);
    E.do('service', `select public.edition_commission_refund_mark('${ra}', 'retry', 'HTTP 503')`);
    assert.equal(row(`select commission_attempts || '|' || (commission_next_attempt_at > now())::text from edition_refund_requests where id='${ra}'`), '1|true');
    assert.equal(row(`select count(*) from public.edition_commission_refunds_next()`), '0', 'not due yet');
    for (let i = 0; i < 5; i++) E.do('service', `select public.edition_commission_refund_mark('${ra}', 'retry', 'HTTP 503')`);
    assert.equal(row(`select commission_refund_status from edition_refund_requests where id='${ra}'`), 'failed'); assert.equal(exc('commission_refund_failed'), '1');
    assert.equal(pp('pi_f2', 'commission_refunded_pence'), '0', 'nothing was returned: the ledger did not advance');
  });
  test('refund_application_fee = false returns no commission; a membership invoice refund works the same way', () => {
    cfg('editions.commerce.refund_application_fee', 'false');
    const pm = pay('in_m2'); const rq = last(E.do('OWNER', `select public.edition_payment_request_refund('${pm}', 500, 'Half back')`));
    E.do('service', `select public.edition_refund_request_mark('${rq}', 'submitted', null)`); E.do('service', `select public.edition_commission_plan_pending()`);
    assert.equal(row(`select commission_refund_pence || '|' || commission_refund_status from edition_refund_requests where id='${rq}'`), '0|done');
    cfg('editions.commerce.refund_application_fee', 'true');
    const rq2 = last(E.do('OWNER', `select public.edition_payment_request_refund('${pay('in_r1')}', 500, 'Half back')`));
    E.do('service', `select public.edition_refund_request_mark('${rq2}', 'submitted', null)`); E.do('service', `select public.edition_commission_plan_pending()`);
    assert.equal(row(`select commission_refund_pence from edition_refund_requests where id='${rq2}'`), '10', '20 x 500 / 1000');
    E.do('service', `select public.edition_commission_refund_mark('${rq2}', 'done', null)`); E.do('service', `select public.edition_payment_refunded('${row(`select stripe_payment_intent_id from edition_payments where stripe_invoice_id='in_r1'`)}', 500)`);
  });
  test('statements: the administrator and the organiser see commission after refunds, the estimate, actuals, variance and net', () => {
    assert.doesNotMatch(E.try('ADMIN', `select * from public.admin_edition_fee_statement(now() - interval '1 year', now() + interval '1 day')`), /ERROR/);
    const r = A(`select payments || '|' || gross_pence || '|' || refunded_pence || '|' || commission_pence || '|' || commission_refunded_pence || '|' || commission_earned_pence || '|' || processing_fee_estimate_pence || '|' || commission_vat_pence from public.admin_edition_fee_statement(now() - interval '1 year', now() + interval '1 day') where organiser_id='${ORG}'`);
    const x = r.split('|').map(Number); assert.equal(x[7], 0, 'no VAT on commission'); assert.equal(x[3] - x[4], x[5]);
    assert.equal(row(`select sum(charge_pence - platform_fee_pence - refunded_pence + commission_refunded_pence - dispute_recovered_pence) from edition_payments where organiser_id='${ORG}' and source='stripe' and status <> 'failed'`), A(`select organiser_net_pence from public.admin_edition_fee_statement(now() - interval '1 year', now() + interval '1 day') where organiser_id='${ORG}'`));
    assert.equal(A(`select organiser_net_pence from public.admin_edition_fee_statement(now() - interval '1 year', now() + interval '1 day') where organiser_id='${ORG}'`) !== '', true);
    // the full-refund payment: the organiser ends -recovery relative to before the sale (net = commission - F = -50)
    assert.equal(row(`select charge_pence - platform_fee_pence - refunded_pence + commission_refunded_pence from edition_payments where stripe_payment_intent_id='pi_f1'`), '-50');
    const o = E.one('OWNER', `select commission_pence || '|' || commission_refunded_pence || '|' || processing_fee_estimate_pence || '|' || coalesce(stripe_fee_pence::text, 'hidden') from public.edition_org_payments('${ORG}') where payment_id='${pay('pi_f1')}'`);
    assert.equal(o, '40|40|50|hidden', 'organiser sees commission and ESTIMATED fee; Stripe\'s actual fee is not shown');
    assert.equal(E.one('OWNER', `select count(*) from public.edition_org_statement('${ORG}', now() - interval '1 year', now() + interval '1 day') where stripe_fee_pence is null`) !== '0', true);
    assert.equal(row(`select count(*) from information_schema.routines r join information_schema.parameters p on p.specific_name = r.specific_name where r.routine_name='edition_my_payments' and p.parameter_mode='OUT' and p.parameter_name ~ 'fee|commission'`), '0', 'the paying business never sees fee columns');
  });
});

describe('disputes: record, recover, insufficient balance, idempotency', () => {
  let P = '', PI = '';
  const ev = (pi: string, dp: string, event: string, status: string, amount = 'null', fee = 'null') => E.doOne('service', `select public.edition_dispute_event('${pi}', '${dp}', '${event}', '${status}', ${amount}, ${fee}, 'fraudulent')`);
  before(() => {
    const b = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active, subscription_tier, subscription_until) values ('${USERS.HUB_MEMBER}', 'ZZ Dispute Deli', 'food_drink', 'x', true, 'pro', now() + interval '90 days') returning id`));
    const l = last(E.do('OWNER', `select public.edition_invite_partner('${ED}','business','${b}')`)); E.do('STRANGER', `select 1`); E.sup(`update edition_links set state='approved' where id='${l}'`);
    E.sup(`insert into edition_participations (link_id, edition_id, business_id, status, basis, quoted_price_pence, quoted_charge_pence) values ('${l}', '${ED}', '${b}', 'awaiting_payment', 'fee', 2000, 2000)`);
    succeedP(l, 'pi_d1', 2000, '50', '90'); PI = 'pi_d1'; P = pay('pi_d1');
  });
  test('created: recorded, payment marked disputed, exception raised; duplicates change nothing; the dispute fee is recorded', () => {
    assert.equal(ev(PI, 'dp_1', 'created', 'needs_response', '2000', '1500'), 'recorded'); ev(PI, 'dp_1', 'created', 'needs_response', '2000', '1500'); ev(PI, 'dp_1', 'updated', 'under_review', '2000', '1500');
    assert.equal(pp(PI, `status || '|' || dispute_state`), 'disputed|open'); assert.equal(exc('dispute', PI), '1');
    assert.equal(row(`select count(*) || '|' || max(fee_pence) from edition_dispute_recoveries where dispute_id='dp_1'`), '1|1500');
    assert.equal(ev('pi_nope', 'dp_x1', 'created', 'needs_response', '100'), 'unknown_payment');
  });
  test('won: nothing is recovered and the payment is released; an out-of-order or duplicate event after the outcome changes nothing', () => {
    assert.equal(ev(PI, 'dp_1', 'closed', 'won', '2000'), 'won');
    assert.equal(pp(PI, `status || '|' || dispute_state`), 'succeeded|won'); assert.equal(row(`select status from edition_dispute_recoveries where dispute_id='dp_1'`), 'none');
    assert.equal(ev(PI, 'dp_1', 'created', 'needs_response', '2000'), 'already_closed'); assert.equal(ev(PI, 'dp_1', 'closed', 'lost', '2000'), 'already_closed');
    assert.equal(row(`select count(*) from public.edition_dispute_recoveries_next()`), '0');
  });
  test('lost (closed arrives BEFORE created is also fine): recovery queued for the disputed amount; commission and estimate are kept; duplicates queue nothing more', () => {
    assert.equal(ev(PI, 'dp_2', 'closed', 'lost', '2000', '1500'), 'lost');
    assert.equal(ev(PI, 'dp_2', 'created', 'needs_response', '2000'), 'already_closed'); ev(PI, 'dp_2', 'closed', 'lost', '2000');
    assert.equal(row(`select state || '|' || recovery_pence || '|' || status || '|' || commission_refund_status from edition_dispute_recoveries where dispute_id='dp_2'`), 'lost|2000|pending|none');
    assert.equal(pp(PI, `status || '|' || dispute_state || '|' || dispute_lost_pence || '|' || dispute_recovered_pence || '|' || commission_refunded_pence`), 'disputed|lost|2000|0|0');
    assert.equal(row(`select dispute_id || '|' || amount_pence || '|' || stripe_charge_id from public.edition_dispute_recoveries_next()`), 'dp_2|2000|ch_pi_d1');
    const q = C.transferReversalRequest({ transfer_id: 'tr_1', amount_pence: 2000, dispute_id: 'dp_2' }); assert.deepEqual([q.path, q.params.amount, q.idempotencyKey], ['/transfers/tr_1/reversals', '2000', 'ed-disputerev-dp_2-2000']);
  });
  test('insufficient connected balance: the failure is recorded, an administrator exception is raised, collection is suspended, the request stays pending but is NOT offered again (no loop)', () => {
    E.do('service', `select public.edition_dispute_recovery_mark('dp_2', 'insufficient', 'Insufficient funds in Stripe account.', null)`);
    assert.equal(row(`select status || '|' || blocked || '|' || attempts || '|' || last_error from edition_dispute_recoveries where dispute_id='dp_2'`), 'pending|true|1|Insufficient funds in Stripe account.');
    assert.equal(exc('dispute_recovery_failed', 'dp_2'), '1');
    assert.equal(row(`select collection_suspended || '|' || suspended_reason from edition_payout_accounts where organiser_id='${ORG}'`), 'true|Dispute recovery could not be collected (insufficient balance): dp_2');
    assert.equal(row(`select coalesce(public.edition_collect_blocker('${ORG}'), 'OPEN')`), 'collection_suspended');
    assert.equal(row(`select count(*) from edition_audit_log where action in ('collection_suspended','dispute_recovery_blocked')`) >= '2', true);
    for (let i = 0; i < 3; i++) assert.equal(row(`select count(*) from public.edition_dispute_recoveries_next()`), '0', 'never offered to the worker again by itself');
    E.do('service', `select public.edition_dispute_recovery_mark('dp_2', 'insufficient', 'again', null)`);
    assert.equal(exc('dispute_recovery_failed', 'dp_2'), '1', 'one exception');
  });
  test('manual retry: admins only, a note is needed; it re-queues but does not lift the suspension; success records the recovery', () => {
    for (const w of ['OWNER', 'BIZ1', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select public.admin_retry_edition_dispute_recovery('dp_2', 'ZZ balance topped up')`)), w);
    assert.match(E.try('ADMIN', `select public.admin_retry_edition_dispute_recovery('dp_2', '')`), /note is required/);
    assert.match(E.try('ADMIN', `select public.admin_retry_edition_dispute_recovery('dp_1', 'ZZ nothing to retry here')`), /no blocked or failed recovery/);
    E.do('ADMIN', `select public.admin_retry_edition_dispute_recovery('dp_2', 'ZZ organiser balance topped up')`);
    assert.equal(row(`select count(*) from public.edition_dispute_recoveries_next()`), '1'); assert.equal(row(`select collection_suspended from edition_payout_accounts where organiser_id='${ORG}'`), 't');
    E.do('service', `select public.edition_dispute_recovery_mark('dp_2', 'retry', 'HTTP 503', null)`);
    assert.equal(row(`select count(*) from public.edition_dispute_recoveries_next()`), '0', 'a temporary failure backs off');
    E.sup(`update edition_dispute_recoveries set next_attempt_at = now() where dispute_id='dp_2'`);
    E.do('service', `select public.edition_dispute_recovery_mark('dp_2', 'done', null, 'trr_1')`); E.do('service', `select public.edition_dispute_recovery_mark('dp_2', 'done', null, 'trr_2')`);
    assert.equal(row(`select status || '|' || stripe_reversal_id from edition_dispute_recoveries where dispute_id='dp_2'`), 'done|trr_1', 'idempotent: the second mark is ignored');
    assert.equal(pp(PI, 'dispute_recovered_pence'), '2000');
    E.do('ADMIN', `select public.admin_set_edition_collection('${ORG}', false, 'ZZ resumed after recovery')`);
    assert.equal(row(`select coalesce(public.edition_collect_blocker('${ORG}'), 'OPEN')`), 'OPEN');
  });
  test('a permanent failure raises an exception without suspending; a prior partial refund limits what can be reversed; the optional commission return is config-gated', () => {
    const b = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active, subscription_tier, subscription_until) values ('${USERS.HUB_COMMITTEE}', 'ZZ Dispute Pie', 'food_drink', 'x', true, 'pro', now() + interval '90 days') returning id`));
    const l = last(E.do('OWNER', `select public.edition_invite_partner('${ED}','business','${b}')`)); E.sup(`update edition_links set state='approved' where id='${l}'`);
    E.sup(`insert into edition_participations (link_id, edition_id, business_id, status, basis, quoted_price_pence, quoted_charge_pence) values ('${l}', '${ED}', '${b}', 'awaiting_payment', 'fee', 2000, 2000)`);
    succeedP(l, 'pi_d2', 2000, '50', '90');
    E.sup(`update edition_payments set refunded_pence = 600, status='partially_refunded' where stripe_payment_intent_id='pi_d2'`);
    cfg('editions.commerce.refund_commission_on_dispute', 'true');
    assert.equal(ev('pi_d2', 'dp_3', 'closed', 'lost', '2000'), 'lost');
    assert.equal(row(`select recovery_pence || '|' || commission_refund_pence || '|' || commission_refund_status from edition_dispute_recoveries where dispute_id='dp_3'`), '1400|40|pending', 'only the unreversed 1400 can be recovered; commission share of 2000 returned when configured');
    cfg('editions.commerce.refund_commission_on_dispute', 'false');
    E.do('service', `select public.edition_dispute_recovery_mark('dp_3', 'failed', 'transfer already reversed', null)`);
    assert.equal(row(`select status from edition_dispute_recoveries where dispute_id='dp_3'`), 'failed'); assert.equal(exc('dispute_recovery_failed', 'dp_3'), '1');
    assert.equal(row(`select coalesce(public.edition_collect_blocker('${ORG}'), 'OPEN')`), 'OPEN', 'a permanent failure alerts but does not suspend');
    assert.equal(row(`select count(*) from public.edition_dispute_commission_next()`), '0', 'a failed recovery does not return commission');
    E.do('ADMIN', `select public.admin_retry_edition_dispute_recovery('dp_3', 'ZZ retry after fixing')`); assert.equal(row(`select status from edition_dispute_recoveries where dispute_id='dp_3'`), 'pending');
    E.do('service', `select public.edition_dispute_recovery_mark('dp_3', 'done', null, 'trr_3')`);
    assert.equal(row(`select count(*) from public.edition_dispute_commission_next()`), '1');
    E.do('service', `select public.edition_dispute_commission_mark('dp_3', 'done', null)`); E.do('service', `select public.edition_dispute_commission_mark('dp_3', 'done', null)`);
    assert.equal(pp('pi_d2', 'commission_refunded_pence'), '40', 'applied once');
  });
  test('the statement shows dispute losses, recoveries and fees', () => {
    assert.equal(A(`select dispute_lost_pence || '|' || dispute_recovered_pence || '|' || dispute_fees_pence from public.admin_edition_fee_statement(now() - interval '1 year', now() + interval '1 day') where organiser_id='${ORG}'`).split('|').every((v) => Number(v) >= 0), true);
    assert.equal(A(`select dispute_recovered_pence from public.admin_edition_fee_statement(now() - interval '1 year', now() + interval '1 day') where organiser_id='${ORG}'`), '3400', 'dp_2 (2000) and dp_3 (1400) recovered');
  });
});

describe('reconciliation and the variance report', () => {
  const rec = (snap: unknown[]) => E.doOne('service', `select public.edition_reconcile_apply('${JSON.stringify(snap)}'::jsonb, now() - interval '1 day', now() + interval '1 day')::text`);
  test('fee within tolerance is fine; beyond it, a mismatch; Stripe\'s actual fee sets the variance; exceptions are raised once', () => {
    const f = C.feeParts(2000, CFG).fee;
    E.sup(`update edition_payments set stripe_fee_pence = null, recovery_variance_pence = null where stripe_payment_intent_id='pi_f2'`);
    rec([{ payment_intent: 'pi_f2', amount: 2000, application_fee: f + 1, refunded: 0, destination: 'acct_fee_1', status: 'succeeded', stripe_fee: 36 }]);
    assert.equal(pp('pi_f2', `stripe_fee_pence || '|' || recovery_variance_pence`), '36|14'); assert.equal(exc('fee_mismatch', 'pi_f2'), '1', 'only the earlier 2p one');
    rec([{ payment_intent: 'pi_f2', amount: 2000, application_fee: f + 5, refunded: 0, destination: 'acct_fee_1', status: 'succeeded' }]);
    rec([{ payment_intent: 'pi_f2', amount: 2000, application_fee: f + 5, refunded: 0, destination: 'acct_fee_1', status: 'succeeded' }]);
    assert.equal(exc('fee_mismatch', 'pi_f2'), '1', 'one open exception per kind and reference');
  });
  test('commission refunded, transfer and reversal totals are compared when nothing is in flight', () => {
    const pi = 'pi_f1';   // fully refunded: commission refunded 40, reversed 2000, transfer 2000
    const ok = { payment_intent: pi, amount: 2000, application_fee: 90, refunded: 2000, destination: 'acct_fee_1', status: 'succeeded', application_fee_refunded: 40, transfer_amount: 2000, transfer_reversed: 2000 };
    rec([ok]); assert.equal(exc('commission_refund_mismatch') + exc('transfer_mismatch'), '00');
    rec([{ ...ok, application_fee_refunded: 25, transfer_amount: 1500, transfer_reversed: 1000 }]);
    assert.equal(exc('commission_refund_mismatch'), '1'); assert.equal(exc('transfer_mismatch'), '1', 'the open transfer exception of each ref is one row');
  });
  test('variance report: by month and by organiser, items over the threshold; a lower threshold catches more; resolving needs an admin note', () => {
    assert.doesNotMatch(E.try('ADMIN', `select * from public.admin_edition_variance_report(now() - interval '1 year', now() + interval '1 day', 'month')`), /ERROR/);
    const m = A(`select group_key || '|' || payments || '|' || over_threshold from public.admin_edition_variance_report(now() - interval '1 year', now() + interval '1 day', 'month') limit 1`).split('|');
    assert.match(m[0], /^\d{4}-\d{2}$/); assert.ok(Number(m[1]) >= 3);
    assert.equal(A(`select count(*) from public.admin_edition_variance_report(now() - interval '1 year', now() + interval '1 day', 'organiser')`), '1');
    assert.equal(A(`select sum(variance_pence) from public.admin_edition_variance_report(now() - interval '1 year', now() + interval '1 day', 'month')`), row(`select sum(recovery_variance_pence) from edition_payments where recovery_variance_pence is not null`));
    assert.match(E.try('ADMIN', `select * from public.admin_edition_variance_report(now() - interval '1 year', now() + interval '1 day', 'week')`), /group by month or organiser/);
    const before = A(`select count(*) from public.admin_edition_variance_items(now() - interval '1 year', now() + interval '1 day')`);
    cfg('editions.commerce.variance_alert_pence', '5');
    assert.ok(Number(A(`select count(*) from public.admin_edition_variance_items(now() - interval '1 year', now() + interval '1 day')`)) >= Number(before)); cfg('editions.commerce.variance_alert_pence', '20');
    const notes = JSON.parse(E.one('ADMIN', `select public.admin_edition_fee_model_notes()::text`));
    assert.equal(notes.rates_confirmed, false); assert.match(notes.connect_overheads, /absorbed by OneShetland/); assert.match(notes.variance_treatment, /pending commercial decision/); assert.match(notes.vat, /not VAT registered/);
    const ex = row(`select id from edition_reconciliation_exceptions where kind='fee_variance' limit 1`);
    assert.ok(failed(E.try('OWNER', `select public.admin_resolve_edition_exception('${ex}', 'ZZ not me')`)));
    assert.ok(!failed(E.try('ADMIN', `select public.admin_resolve_edition_exception('${ex}', 'ZZ accepted variance')`)));
  });
});

describe('ledger integrity, backfill and VAT readiness', () => {
  test('append-only still holds: parts are fixed once recorded; refund and dispute facts never go down; rows cannot be deleted', () => {
    assert.match(E.sup(`update edition_payments set commission_pence = 1 where stripe_payment_intent_id='pi_f1'`), /append-only/);
    assert.match(E.sup(`update edition_payments set charge_pence = charge_pence + 1 where stripe_payment_intent_id='pi_f1'`), /append-only/);
    assert.match(E.sup(`update edition_payments set commission_refunded_pence = 1 where stripe_payment_intent_id='pi_f1'`), /cannot be reduced/);
    assert.match(E.sup(`update edition_payments set dispute_recovered_pence = 0 where stripe_payment_intent_id='pi_d1'`), /cannot be reduced/);
    assert.match(E.sup(`update edition_payments set stripe_fee_refunded_pence = 5 where stripe_payment_intent_id='pi_f1'`), /violates check|append-only/);
    assert.match(E.sup(`delete from edition_payments where stripe_payment_intent_id='pi_f1'`), /cannot be deleted/);
  });
  test('backfill: the migration\'s own statement derives parts from the old single fee, once, without touching anything else', () => {
    const sql = readFileSync(new URL('../migrations/20270105000000_editions_fee_model.sql', import.meta.url), 'utf8').match(/^update public\.edition_payments set commission_pence = platform_fee_pence[^\n]*$/m)?.[0];
    assert.ok(sql, 'the backfill statement exists');
    E.sup(`alter table edition_payments disable trigger edition_payments_parts_default`);
    const id = last(E.sup(`insert into edition_payments (organiser_id, business_id, kind, ref_id, source, status, price_pence, platform_fee_pence, charge_pence, net_to_organiser_pence, stripe_payment_intent_id) values ('${ORG}', '${B1}', 'participation', gen_random_uuid(), 'stripe', 'succeeded', 1000, 50, 1000, 950, 'pi_legacy') returning id`));
    assert.equal(row(`select commission_pence is null from edition_payments where id='${id}'`), 't');
    E.sup(sql);
    assert.equal(row(`select commission_pence || '|' || recovery_estimate_pence || '|' || platform_fee_pence || '|' || net_to_organiser_pence || '|' || commission_refunded_pence from edition_payments where id='${id}'`), '50|0|50|950|0');
    E.sup(`alter table edition_payments enable trigger edition_payments_parts_default`);
    assert.equal(row(`select count(*) from edition_payments where commission_pence is null`), '0');
  });
  test('offline records carry explicit zero parts', () => {
    const l = last(E.do('OWNER', `select public.edition_invite_partner('${ED}','business','${last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${USERS.EDITOR}', 'ZZ Fee Offline', 'retail', 'x', true) returning id`))}')`));
    E.sup(`update edition_links set state='approved' where id='${l}'`);
    const p = last(E.do('OWNER', `select public.edition_participation_record_offline('${l}', 2000, 'cheque', 'Cheque 99 from the committee')`));
    assert.equal(row(`select commission_pence || '|' || recovery_estimate_pence || '|' || platform_fee_pence from edition_payments where id='${p}'`), '0|0|0');
  });
  test('VAT readiness: additive nullable columns on package orders and a platform flag nothing charges from; commission statements carry VAT 0', () => {
    for (const c of ['net_pence', 'vat_pence', 'vat_rate_percent', 'buyer_vat_number', 'billing_name', 'billing_address', 'vat_note']) assert.equal(row(`select is_nullable from information_schema.columns where table_name='edition_orders' and column_name='${c}'`), 'YES', c);
    assert.equal(row(`select count(*) from pg_proc where prosrc like '%platform.vat_registered%' and proname not in ('admin_set_edition_commerce_config','admin_edition_fee_model_notes')`), '0', 'no other function reads the flag');
    assert.equal(A(`select distinct commission_vat_pence from public.admin_edition_fee_statement(now() - interval '1 year', now() + interval '1 day')`), '0');
  });
  test('package orders (flow A) are untouched: the order intent carries no transfer or application fee', () => {
    const op = C.orderIntentParams({ order_id: '6f1c2b3a-1111-4222-8333-444455556666', organiser_id: '6f1c2b3a-1111-4222-8333-444455556666', amount_pence: 12500, edition_id: '6f1c2b3a-1111-4222-8333-444455556666', buyer_id: '6f1c2b3a-1111-4222-8333-444455556666' });
    assert.ok(!('application_fee_amount' in op) && !('transfer_data[destination]' in op));
  });
});
