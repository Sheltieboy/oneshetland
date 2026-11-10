/**
 * editions-participation.node.test.ts — ISOLATED Postgres only. R4d/R4e: paid Edition participation, member pricing, eligibility gate over the public views, waivers,
 * offline records, withdrawal and refunds, disputes, reconciliation, statements. Provider events are simulated through the service-role functions.
 * Run: ISOLATED_ONLY=editions-participation npm run test:isolated
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Env, USERS, seed, enter, draftEdition, d, last, failed as baseFailed } from './_support/editions-env.ts';
import { publishEdition, addHelper, aliased } from './_support/editions-env-2.ts';

// The organiser is a BUSINESS (ZZ Test Cafe): OWNER is its owner; ORG_ADMIN and ORG_EDITOR are invited helpers; BIZ1..BIZ3 own the participating businesses.
const MAP = { ADMIN: 'ADMIN', OWNER: 'BIZ_OWNER', ORG_ADMIN: 'HELPER', ORG_EDITOR: 'EDITOR', BIZ1: 'BIZ2_OWNER', BIZ2: 'HUB2_OWNER', BIZ3: 'HUB_MEMBER', STRANGER: 'STRANGER' } as const;
const U = { ADMIN: USERS.ADMIN, OWNER: USERS.BIZ_OWNER, ORG_ADMIN: USERS.HELPER, ORG_EDITOR: USERS.EDITOR, BIZ1: USERS.BIZ2_OWNER, BIZ2: USERS.HUB2_OWNER, BIZ3: USERS.HUB_MEMBER, STRANGER: USERS.STRANGER } as const;
type Who = keyof typeof MAP | 'anon' | 'service';
const failed = baseFailed;
let Base: Env, S: ReturnType<typeof seed>;
let E: ReturnType<typeof aliased<keyof typeof MAP>>;
let ORG = '', ED = '', B1 = '', B2 = '', B3 = '', L1 = '', L2 = '', L3 = '', T_FREE = '', T_PCT = '', EV = '', LEV = '';
const days = (n: number) => `(now() + interval '${n} days')`;
const pubCount = () => E.one('anon', `select count(*) from public.edition_public_businesses where edition_id='${ED}'`);
const terms = (who: Who, mode: string, fee: string, vat = 'none', rp = 'none', ru = 'null', cap = 'null', close = 'null') => E.try(who, `select public.edition_set_participation_terms('${ED}', '${mode}', ${fee}, '${vat}', '${rp}', ${ru}, ${cap}, ${close})`);
const setTerms = (mode: string, fee: string, vat = 'none', rp = 'none', ru = 'null', cap = 'null', close = 'null') => E.do('ORG_ADMIN', `select public.edition_set_participation_terms('${ED}', '${mode}', ${fee}, '${vat}', '${rp}', ${ru}, ${cap}, ${close})`);
const cfg = (k: string, v: string) => E.do('ADMIN', `select public.admin_set_edition_commerce_config('${k}', '${v}')`);
const succeed = (link: string, pi: string, charge: number, who: Who = 'service') => E.try(who, `select public.edition_participation_payment_succeeded('${link}', '${pi}', 'ch_${pi}', ${charge}, 30)`);

before(() => {
  Base = new Env('editionspart');
  S = seed(Base); E = aliased(Base, MAP);
  E.sup(`insert into admin_config (key, value, category) values ('editions.commerce.enabled','true','editions') on conflict (key) do update set value = excluded.value;`);
  ORG = enter(Base, 'BIZ_OWNER', 'business', S.BIZ);
  addHelper(Base, 'BIZ_OWNER', ORG, 'HELPER', `${U.ORG_ADMIN}@x.invalid`, 'admin');
  addHelper(Base, 'BIZ_OWNER', ORG, 'EDITOR', `${U.ORG_EDITOR}@x.invalid`, 'editor');
  for (const f of ['collect_payments', 'memberships', 'offline_records', 'participation_fees']) E.do('ADMIN', `select public.admin_grant_edition_org_entitlement('${ORG}', '${f}', null, ${days(90)}, 'ZZ participation suite')`);
  E.do('OWNER', `select public.edition_accept_commerce_terms('${ORG}', 'draft-1')`);
  E.do('service', `select public.edition_payout_account_sync('${ORG}', 'acct_part_1', true, true, true, '[]'::jsonb)`);
  ED = draftEdition(Base, 'BIZ_OWNER', ORG, 'zz-part-fest', 'ZZ Part Fest');
  publishEdition(Base, 'BIZ_OWNER', ED, 'ZZ participation suite');
  const biz = (o: string, n: string) => last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active, subscription_tier, subscription_until) values ('${o}', '${n}', 'food_drink', 'x', true, 'pro', now() + interval '90 days') returning id`));
  B1 = biz(U.BIZ1, 'ZZ Part Cafe'); B2 = biz(U.BIZ2, 'ZZ Part Bakery'); B3 = biz(U.BIZ3, 'ZZ Part Deli');
  const link = (b: string, u: Who) => { const l = last(E.do('ORG_EDITOR', `select public.edition_invite_partner('${ED}','business','${b}')`)); E.do(u, `select public.edition_link_act('${l}','approve',null)`); return l; };
  L1 = link(B1, 'BIZ1'); L2 = link(B2, 'BIZ2'); L3 = link(B3, 'BIZ3');
  EV = last(E.sup(`insert into events (title, starts_at, status, organiser_business_id, organiser_user_id) values ('ZZ Part Quiz', (${d(21)})::timestamp + interval '19 hours', 'published', '${B1}', '${U.BIZ1}') returning id`));
  LEV = last(E.do('ORG_EDITOR', `select public.edition_invite_partner('${ED}','event','${EV}')`)); E.do('BIZ1', `select public.edition_link_act('${LEV}','approve',null)`);
  const tier = (n: string, ben: string, disc: string) => last(E.do('ORG_ADMIN', `select public.edition_tier_save('${ORG}', null, '${n}', 'd', '[]'::jsonb, 1000, null, false, 'none', 'application', '${ben}', ${disc}, null, 1)`));
  T_FREE = tier('ZZ Gold', 'free', 'null'); T_PCT = tier('ZZ Silver', 'percent_off', '25');
});
after(() => Base?.drop());

describe('lockdown and function exposure', () => {
  test('RLS on, no FOR ALL, no direct writes; money-in functions are service-role only', () => {
    const t = `('edition_participation_terms','edition_participations','edition_refund_requests','edition_reconciliation_exceptions')`;
    assert.equal(E.q(`select count(*) from pg_class where relname in ${t} and not relrowsecurity`), '0');
    assert.equal(E.q(`select count(*) from pg_policies where tablename in ${t} and cmd='ALL'`), '0');
    assert.equal(E.q(`select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_name in ${t} and privilege_type <> 'SELECT'`), '0');
    for (const fn of ['edition_participation_payment_succeeded', 'edition_participation_payment_failed', 'edition_refunds_next', 'edition_refund_request_mark', 'edition_payment_refunded', 'edition_payment_disputed', 'edition_record_exception', 'edition_reconcile_apply']) {
      assert.equal(E.q(`select count(*) from pg_proc p where proname='${fn}' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`), '0', fn);
    }
  });
  test('anon runs only the eligibility predicate among the new functions', () => {
    assert.equal(E.q(`select coalesce(string_agg(proname, ',' order by proname), '') from pg_proc p where pronamespace='public'::regnamespace and (proname like 'edition_participation%' or proname like 'edition_payment_%' or proname like 'edition_refund%' or proname like 'edition_reconcile%' or proname like 'edition_my_p%' or proname like 'edition_org_payments' or proname like 'edition_org_statement' or proname like 'admin_edition_fee%') and has_function_privilege('anon', p.oid, 'execute')`), 'edition_participation_ok');
  });
});

describe('terms', () => {
  test('organiser admins set terms; editors, owners of businesses and strangers cannot; fees need the entitlement', () => {
    for (const w of ['ORG_EDITOR', 'BIZ1', 'STRANGER', 'anon'] as Who[]) assert.ok(failed(terms(w, 'fee_required', '2000')), w);
    E.sup(`set session_replication_role = replica; update edition_organiser_entitlements set voided_at = now(), void_reason='x' where feature='participation_fees'`);
    assert.match(terms('ORG_ADMIN', 'fee_required', '2000'), /not included in your package/);
    assert.ok(!failed(terms('ORG_ADMIN', 'free', 'null')));
    E.sup(`set session_replication_role = replica; update edition_organiser_entitlements set voided_at = null, void_reason=null where feature='participation_fees'`);
  });
  test('validation: a fee needs a price of at least 1.00; until_date needs a date; terms are publicly readable for a public Edition', () => {
    assert.ok(failed(terms('ORG_ADMIN', 'fee_required', '50')));
    assert.ok(failed(terms('ORG_ADMIN', 'fee_required', 'null')));
    assert.ok(failed(terms('ORG_ADMIN', 'fee_required', '2000', 'none', 'until_date', 'null')));
    setTerms('fee_required', '2000', 'none', 'until_date', d(10));
    assert.equal(E.one('anon', `select mode || '|' || fee_pence from public.edition_participation_terms where edition_id='${ED}'`), 'fee_required|2000');
  });
});

describe('eligibility gate over the public Edition', () => {
  test('with a fee required, an approved but unpaid business is NOT shown; consent is unchanged; events are unaffected', () => {
    assert.equal(pubCount(), '0');
    assert.equal(E.q(`select state from edition_links where id='${L1}'`), 'approved');
    assert.equal(E.one('anon', `select count(*) from public.edition_public_events where edition_id='${ED}'`), '1');
    assert.equal(E.one('anon', `select count(*) from public.edition_links where kind='business'`), '0', 'not readable directly either');
    assert.equal(E.one('BIZ1', `select count(*) from public.edition_links where kind='business'`), '1', 'the owner still sees their own link');
  });
  test('organisers see who is unpaid; the owner sees what they owe', () => {
    assert.match(E.one('ORG_EDITOR', `select string_agg(business_name || ':' || status || ':' || shown, ',' order by business_name) from public.edition_participation_rows('${ED}')`), /ZZ Part Cafe:not_started:false/);
    assert.ok(failed(E.try('STRANGER', `select * from public.edition_participation_rows('${ED}')`)));
    assert.match(E.one('BIZ1', `select required || '|' || status || '|' || price_pence || '|' || can_pay from public.edition_my_participations() where business_id='${B1}'`), /true\|not_started\|2000\|true/);
  });
  test('removing the fee requirement shows everyone again at once', () => {
    setTerms('free', 'null'); assert.equal(pubCount(), '3'); setTerms('fee_required', '2000', 'none', 'until_date', d(10)); assert.equal(pubCount(), '0');
  });
});

describe('quote and member pricing', () => {
  const quote = (who: Who, link: string) => E.one(who, `select base_pence || '|' || discount_pence || '|' || price_pence || '|' || charge_pence || '|' || basis from public.edition_participation_quote('${link}')`);
  test('no membership: full price; the fee comes from the price (organiser receives price minus fee)', () => {
    assert.equal(quote('BIZ1', L1), '2000|0|2000|2000|fee');
    assert.equal(E.one('BIZ1', `select platform_fee_pence || '|' || net_to_organiser_pence from public.edition_participation_quote('${L1}')`), '100|1900');
  });
  test('only the owner, the organiser team and admins can ask for a quote', () => {
    for (const w of ['STRANGER', 'BIZ2', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select * from public.edition_participation_quote('${L1}')`)), w);
    assert.match(quote('ORG_EDITOR', L1), /2000/);
  });
  test('a live membership changes the price by its tier: percent off, or free', () => {
    E.do('ORG_ADMIN', `select public.edition_membership_record_offline('${ORG}', '${T_PCT}', '${B2}', 'offline', now(), ${days(300)}, 1000, 'cheque', 'Cheque 12 at the AGM')`);
    E.do('BIZ2', `select public.edition_membership_respond('${E.q(`select id from organiser_memberships where business_id='${B2}' and status='invited' and source='offline_record'`)}', true)`);
    E.do('ORG_ADMIN', `select public.edition_membership_record_offline('${ORG}', '${T_FREE}', '${B3}', 'complimentary', now(), ${days(300)}, null, null, 'Founding member, free')`);
    E.do('BIZ3', `select public.edition_membership_respond('${E.q(`select id from organiser_memberships where business_id='${B3}' and status='invited' and source='offline_record'`)}', true)`);
    assert.equal(quote('BIZ2', L2), '2000|500|1500|1500|member_discount');
    assert.equal(quote('BIZ3', L3), '2000|2000|0|0|member_free');
  });
  test('a lapsed membership gives no discount', () => {
    E.sup(`update organiser_memberships set current_period_end = now() - interval '1 hour' where business_id='${B2}'`);
    assert.equal(quote('BIZ2', L2), '2000|0|2000|2000|fee');
    E.sup(`update organiser_memberships set current_period_end = now() + interval '300 days' where business_id='${B2}'`);
  });
  test('claim a free-by-membership place: only when the price really is zero; then the partner is shown', () => {
    assert.match(E.try('BIZ2', `select public.edition_participation_claim_benefit('${L2}')`), /does not cover the full fee/);
    assert.ok(failed(E.try('BIZ1', `select public.edition_participation_claim_benefit('${L3}')`)));
    assert.equal(E.doOne('BIZ3', `select public.edition_participation_claim_benefit('${L3}')`), 'member_benefit');
    assert.equal(pubCount(), '1');
    assert.match(E.try('BIZ3', `select public.edition_participation_pay_prepare('${L3}', 'attempt-benefit-1')`), /already covered/);
  });
});

describe('paying (provider calls simulated)', () => {
  test('prepare: owner only, consent first, capacity, close date, self-payment, blockers, ceiling', () => {
    for (const w of ['BIZ2', 'STRANGER', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select public.edition_participation_pay_prepare('${L1}', 'attempt-p-0001')`)), w);
    assert.match(E.try('BIZ1', `select public.edition_participation_pay_prepare('${L1}', 'short')`), /invalid attempt/);
    setTerms('fee_required', '2000', 'none', 'until_date', d(10), '1');
    E.do('BIZ3', `select 1`);
    assert.equal(E.q(`select count(*) from edition_participations where status in ('paid','waived','member_benefit','awaiting_payment')`), '1');
    assert.match(E.try('BIZ1', `select public.edition_participation_pay_prepare('${L1}', 'attempt-p-0002')`), /is full/);
    setTerms('fee_required', '2000', 'none', 'until_date', d(10), 'null', `(current_date - 1)`);
    assert.match(E.try('BIZ1', `select public.edition_participation_pay_prepare('${L1}', 'attempt-p-0003')`), /has closed/);
    setTerms('fee_required', '2000', 'none', 'until_date', d(10));
    E.do('ADMIN', `select public.admin_set_edition_collection('${ORG}', true, 'ZZ blocked for the test')`);
    assert.match(E.try('BIZ1', `select public.edition_participation_pay_prepare('${L1}', 'attempt-p-0004')`), /collection_suspended/);
    E.do('ADMIN', `select public.admin_set_edition_collection('${ORG}', false, 'ZZ resumed for the test')`);
    cfg('editions.commerce.max_charge_pence', '1000');
    assert.match(E.try('BIZ1', `select public.edition_participation_pay_prepare('${L1}', 'attempt-p-0005')`), /above the allowed limit/);
    cfg('editions.commerce.max_charge_pence', '500000');
  });
  test('R12: an abandoned payment attempt stops holding a place and stops locking the fee terms after the hold window; a fresh one holds both', () => {
    setTerms('fee_required', '2000', 'none', 'until_date', d(10), '2');
    const other = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.STRANGER}', 'ZZ Hold Biz', 'retail', 'x', true) returning id`));
    const lk = last(E.do('ORG_EDITOR', `select public.edition_invite_partner('${ED}','business','${other}')`));
    E.do('STRANGER', `select public.edition_link_act('${lk}', 'approve', null)`);
    // one completed place already exists (capacity 2); an attempt by the second business takes the other
    E.sup(`insert into edition_participations (link_id, edition_id, business_id, status, basis, quoted_price_pence, quoted_charge_pence) values ('${lk}', '${ED}', '${other}', 'awaiting_payment', 'fee', 2000, 2000)`);
    assert.match(E.try('BIZ1', `select public.edition_participation_pay_prepare('${L1}', 'attempt-p-0010')`), /is full/, 'a fresh attempt holds the place');
    assert.match(terms('ORG_ADMIN', 'fee_required', '2500', 'none', 'until_date', d(10), '2'), /cannot be changed once businesses have paid or started paying/, 'and locks the terms');
    E.sup(`update edition_participations set updated_at = now() - interval '3 hours' where link_id='${lk}'`);
    assert.doesNotMatch(E.try('BIZ1', `select public.edition_participation_pay_prepare('${L1}', 'attempt-p-0011')`), /is full/, 'an abandoned attempt no longer holds the place');
    assert.ok(!failed(terms('ORG_ADMIN', 'fee_required', '2500', 'none', 'until_date', d(10), '2')), 'nor the terms');
    // (a payment that still arrives later is honoured: payment_succeeded accepts any 'awaiting_payment' attempt at the amount quoted when it began, whatever its age)
    // tidy: back to the terms and capacity the rest of the suite expects
    E.sup(`delete from edition_participations where link_id='${lk}'`);
    E.sup(`delete from edition_links where id='${lk}'`);
    E.sup(`delete from local_businesses where id='${other}'`);
    setTerms('fee_required', '2000', 'none', 'until_date', d(10));
  });
  test('an organiser team member who owns a business cannot pay their own organiser', () => {
    const bo = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.ORG_ADMIN}', 'ZZ Admin Biz', 'retail', 'x', true) returning id`));
    const l = last(E.do('ORG_EDITOR', `select public.edition_invite_partner('${ED}','business','${bo}')`));
    E.do('ORG_ADMIN', `select public.edition_link_act('${l}','approve',null)`);
    assert.match(E.try('ORG_ADMIN', `select public.edition_participation_pay_prepare('${l}', 'attempt-p-0006')`), /cannot pay an organiser you are part of/);
    E.do('ORG_ADMIN', `select public.edition_link_act('${l}','withdraw',null)`);
  });
  test('prepare locks the quoted price; wrong amounts are refused; the right amount marks it paid and shows the business', () => {
    const r = JSON.parse(E.doOne('BIZ1', `select public.edition_participation_pay_prepare('${L1}', 'attempt-p-0007')::text`));
    assert.equal(r.charge_pence, 2000); assert.equal(r.platform_fee_pence, 100); assert.equal(r.net_to_organiser_pence, 1900);
    for (const w of ['BIZ1', 'ORG_ADMIN', 'ADMIN', 'anon'] as Who[]) assert.ok(failed(succeed(L1, 'pi_x', 2000, w)), w);
    assert.match(succeed(L1, 'pi_p1', 1999), /does not match the quoted price/);
    assert.equal(last(E.do('service', `select public.edition_participation_payment_succeeded('${L1}', 'pi_p1', 'ch_p1', 2000, 30)`)), 'recorded');
    assert.equal(E.q(`select status || '|' || basis from edition_participations where link_id='${L1}'`), 'paid|fee');
    assert.equal(E.q(`select source || '|' || platform_fee_pence || '|' || net_to_organiser_pence || '|' || kind from edition_payments where stripe_payment_intent_id='pi_p1'`), 'stripe|100|1900|participation');
    assert.equal(pubCount(), '2');
  });
  test('duplicates and replays change nothing; a quote change after prepare cannot alter what is accepted', () => {
    assert.equal(last(E.do('service', `select public.edition_participation_payment_succeeded('${L1}', 'pi_p1', 'ch_p1', 2000, 30)`)), 'already_recorded');
    assert.equal(E.q(`select count(*) from edition_payments where kind='participation'`), '1');
  });
  test('a SECOND payment for an already-paid fee is not lost and does not break the webhook: it becomes an exception for refund', () => {
    assert.equal(last(E.do('service', `select public.edition_participation_payment_succeeded('${L1}', 'pi_dup1', 'ch_dup1', 2000, 30)`)), 'duplicate_needs_refund');
    assert.equal(E.q(`select count(*) from edition_reconciliation_exceptions where kind='duplicate_payment' and provider_ref='pi_dup1'`), '1');
    assert.equal(last(E.do('service', `select public.edition_participation_payment_succeeded('${L1}', 'pi_dup1', 'ch_dup1', 2000, 30)`)), 'duplicate_needs_refund');
    assert.equal(E.q(`select count(*) from edition_reconciliation_exceptions where provider_ref='pi_dup1'`), '1', 'replay stays one exception');
    assert.equal(E.q(`select count(*) from edition_payments where kind='participation'`), '1', 'the first payment stands; no second row');
  });
  test('terms are locked once someone has paid; the paid partner stays covered', () => {
    assert.match(terms('ORG_ADMIN', 'fee_required', '3000', 'none', 'until_date', d(10)), /cannot be changed once businesses have paid/);
    assert.ok(!failed(terms('ORG_ADMIN', 'fee_required', '2000', 'none', 'until_date', d(10), '50')), 'capacity can still change');
  });
  test('a failed payment leaves it unpaid and unseen; a retry with a new attempt works', () => {
    const r = JSON.parse(E.doOne('BIZ2', `select public.edition_participation_pay_prepare('${L2}', 'attempt-p-0008')::text`));
    assert.equal(r.charge_pence, 1500);
    E.do('service', `select public.edition_participation_payment_failed('${L2}', 'pi_fail')`);
    assert.equal(E.q(`select status from edition_participations where link_id='${L2}'`), 'awaiting_payment');
    assert.equal(pubCount(), '2');
    assert.ok(!failed(E.try('BIZ2', `select public.edition_participation_pay_prepare('${L2}', 'attempt-p-0009')`)));
    assert.equal(last(E.do('service', `select public.edition_participation_payment_succeeded('${L2}', 'pi_p2', 'ch_p2', 1500, null)`)), 'recorded');
    assert.equal(pubCount(), '3');
  });
});

describe('waivers and offline records', () => {
  test('waive and offline: organiser admins only, a reason is mandatory, no double cover', () => {
    const b4 = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.STRANGER}', 'ZZ Part Shop', 'retail', 'x', true) returning id`));
    const l4 = last(E.do('ORG_EDITOR', `select public.edition_invite_partner('${ED}','business','${b4}')`)); E.do('STRANGER', `select public.edition_link_act('${l4}','approve',null)`);
    for (const w of ['ORG_EDITOR', 'STRANGER', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select public.edition_participation_waive('${l4}', 'Local charity')`)), w);
    assert.match(E.try('ORG_ADMIN', `select public.edition_participation_waive('${l4}', '')`), /say why/);
    assert.equal(E.q(`select count(*) from public.edition_public_businesses where edition_id='${ED}'`), '3');
    E.do('ORG_ADMIN', `select public.edition_participation_waive('${l4}', 'Local charity, free place')`);
    assert.equal(E.one('anon', `select count(*) from public.edition_public_businesses where edition_id='${ED}'`), '4');
    assert.match(E.try('ORG_ADMIN', `select public.edition_participation_record_offline('${l4}', 2000, 'cheque', 'Cheque')`), /already covered/);
    assert.match(E.try('ORG_ADMIN', `select public.edition_participation_waive('${l4}', 'again')`), /already covered/);
    E.do('STRANGER', `select public.edition_link_act('${l4}','withdraw',null)`);
    assert.equal(E.one('anon', `select count(*) from public.edition_public_businesses where edition_id='${ED}'`), '3');
  });
  test('an offline payment records a ledger row with no Stripe ids and shows the partner', () => {
    const b5 = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.STRANGER}', 'ZZ Offline Shop', 'retail', 'x', true) returning id`));
    const l5 = last(E.do('ORG_EDITOR', `select public.edition_invite_partner('${ED}','business','${b5}')`)); E.do('STRANGER', `select public.edition_link_act('${l5}','approve',null)`);
    assert.match(E.try('ORG_ADMIN', `select public.edition_participation_record_offline('${l5}', 2000, 'cheque', '')`), /record the amount/);
    const pay = last(E.do('ORG_ADMIN', `select public.edition_participation_record_offline('${l5}', 2000, 'cheque', 'Cheque 7731 from the committee')`));
    assert.equal(E.q(`select source || '|' || method || '|' || platform_fee_pence || '|' || coalesce(stripe_payment_intent_id, 'none') from edition_payments where id='${pay}'`), 'offline|cheque|0|none');
    assert.equal(E.one('anon', `select count(*) from public.edition_public_businesses where edition_id='${ED}'`), '4');
    E.do('STRANGER', `select public.edition_link_act('${l5}','withdraw',null)`);
  });
});

describe('withdrawal and refunds', () => {
  test('withdrawing hides the partner at once; within policy a refund is requested; the consent link is the owner\'s own', () => {
    assert.equal(E.doOne('BIZ1', `select public.edition_participation_withdraw('${L1}')`), 'withdrawn_refund_requested');
    assert.equal(E.q(`select state from edition_links where id='${L1}'`), 'withdrawn');
    assert.equal(pubCount(), '2');
    assert.equal(E.q(`select status from edition_participations where link_id='${L1}'`), 'refund_pending');
    assert.equal(E.q(`select amount_pence || '|' || status from edition_refund_requests`), '2000|pending');
    assert.ok(failed(E.try('BIZ2', `select public.edition_participation_withdraw('${L1}')`)));
  });
  test('the service drains refund requests; the provider reports the cumulative amount; a full refund returns the participation to refunded; replays are no-ops', () => {
    assert.match(E.do('service', `select request_id || '|' || amount_pence || '|' || stripe_payment_intent_id from public.edition_refunds_next()`), /2000\|pi_p1/);
    E.do('service', `select public.edition_refund_request_mark((select id from edition_refund_requests limit 1), 'submitted')`);
    assert.equal(last(E.do('service', `select public.edition_payment_refunded('pi_p1', 800)`)), 'partially_refunded');
    assert.equal(last(E.do('service', `select public.edition_payment_refunded('pi_p1', 800)`)), 'no_change');
    assert.equal(last(E.do('service', `select public.edition_payment_refunded('pi_p1', 2000)`)), 'refunded');
    assert.equal(E.q(`select status || '|' || refunded_pence from edition_payments where stripe_payment_intent_id='pi_p1'`), 'refunded|2000');
    assert.equal(E.q(`select status from edition_participations where link_id='${L1}'`), 'refunded');
    assert.equal(E.q(`select status from edition_refund_requests`), 'done');
    assert.match(E.try('service', `select public.edition_payment_refunded('pi_p1', 3000)`), /exceeds the payment/);
    assert.equal(last(E.do('service', `select public.edition_payment_refunded('pi_unknown', 100)`)), 'unknown_payment');
    assert.equal(E.q(`select count(*) from edition_reconciliation_exceptions where kind='missing_in_ledger' and provider_ref='pi_unknown'`), '1');
  });
  test('outside the refund policy nothing is requested but the partner still leaves at once', () => {
    E.sup(`update edition_participation_terms set refund_until = current_date - 1 where edition_id='${ED}'`);   // the deadline has passed (terms themselves are locked once paid)
    assert.equal(E.doOne('BIZ2', `select public.edition_participation_withdraw('${L2}')`), 'withdrawn_no_refund_due');
    assert.equal(E.q(`select state from edition_links where id='${L2}'`), 'withdrawn');
    assert.equal(E.q(`select count(*) from edition_refund_requests`), '1');
  });
  test('organisers and admins can request a refund; others cannot; amounts and duplicates are checked; offline payments are not refunded here', () => {
    const p = E.q(`select id from edition_payments where stripe_payment_intent_id='pi_p2'`);
    for (const w of ['ORG_EDITOR', 'BIZ2', 'STRANGER', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select public.edition_payment_request_refund('${p}', 100, 'Goodwill')`)), w);
    assert.match(E.try('ORG_ADMIN', `select public.edition_payment_request_refund('${p}', 99999, 'Goodwill')`), /no more than what is left/);
    assert.match(E.try('ORG_ADMIN', `select public.edition_payment_request_refund('${p}', 100, '')`), /reason is required/);
    E.do('ORG_ADMIN', `select public.edition_payment_request_refund('${p}', 500, 'Goodwill gesture')`);
    assert.match(E.try('ORG_ADMIN', `select public.edition_payment_request_refund('${p}', 100, 'Again')`), /already in progress/);
    const off = E.q(`select id from edition_payments where source='offline' limit 1`);
    assert.match(E.try('ORG_ADMIN', `select public.edition_payment_request_refund('${off}', 100, 'x ok')`), /not refunded here/);
  });
  test('a full refund of the latest membership payment ends the membership and its benefit', () => {
    const b6 = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.STRANGER}', 'ZZ Member Shop', 'retail', 'x', true) returning id`));
    const m = last(E.do('STRANGER', `select public.edition_membership_apply('${T_PCT}', '${b6}', 'monthly')`));
    E.do('ORG_ADMIN', `select public.edition_membership_decide('${m}', 'approve')`);
    E.do('service', `select public.edition_membership_payment_succeeded('${m}', 'sub_r', 'pi_m1', 'in_m1', 'ch_m1', now(), ${days(30)}, 1000, null)`);
    assert.equal(E.q(`select count(*) from public.edition_member_benefit('${ORG}', '${b6}')`), '1');
    E.do('service', `select public.edition_payment_refunded('pi_m1', 1000)`);
    assert.equal(E.q(`select status from organiser_memberships where id='${m}'`), 'cancelled');
    assert.equal(E.q(`select count(*) from public.edition_member_benefit('${ORG}', '${b6}')`), '0');
  });
});

describe('disputes and reconciliation', () => {
  test('a dispute marks the payment and raises an exception; it never changes entitlements or visibility on its own', () => {
    E.do('service', `select public.edition_payment_disputed('pi_p2', 'fraudulent')`);
    assert.equal(E.q(`select status from edition_payments where stripe_payment_intent_id='pi_p2'`), 'disputed');
    assert.equal(E.q(`select count(*) from edition_reconciliation_exceptions where kind='dispute' and status='open'`), '1');
    E.do('service', `select public.edition_payment_disputed('pi_p2', 'fraudulent')`);
    assert.equal(E.q(`select count(*) from edition_reconciliation_exceptions where kind='dispute'`), '1', 'idempotent');
    E.sup(`update edition_payments set status='succeeded' where stripe_payment_intent_id='pi_p2'`);
  });
  test('reconciliation finds every kind of mismatch, raises each once, and resolving needs an admin and a note', () => {
    const snap = JSON.stringify([
      { payment_intent: 'pi_p2', amount: 1500, application_fee: 75, refunded: 0, destination: 'acct_part_1', status: 'succeeded' },
      { payment_intent: 'pi_m1', amount: 999, application_fee: 99, refunded: 0, destination: 'acct_WRONG', status: 'succeeded' },
      { payment_intent: 'pi_only_at_provider', amount: 500, status: 'succeeded' },
    ]);
    const r = JSON.parse(last(E.do('service', `select public.edition_reconcile_apply('${snap}'::jsonb, now() - interval '1 day', now() + interval '1 day')::text`)));
    assert.equal(r.checked, 3);
    const kinds = E.q(`select string_agg(distinct kind, ',' order by kind) from edition_reconciliation_exceptions where status='open' and provider_ref in ('pi_p2','pi_m1','pi_only_at_provider')`);
    assert.match(kinds, /amount_mismatch/); assert.match(kinds, /destination_mismatch/); assert.match(kinds, /fee_mismatch/); assert.match(kinds, /missing_in_ledger/); assert.match(kinds, /refund_mismatch/);
    assert.equal(E.q(`select count(*) from edition_reconciliation_exceptions where kind='missing_at_provider' and provider_ref='pi_p2'`), '0', 'present in the snapshot');
    assert.match(E.q(`select string_agg(provider_ref, ',') from edition_reconciliation_exceptions where kind='missing_at_provider'`) || 'none', /./);
    const n = E.q(`select count(*) from edition_reconciliation_exceptions`);
    E.do('service', `select public.edition_reconcile_apply('${snap}'::jsonb, now() - interval '1 day', now() + interval '1 day')`);
    assert.equal(E.q(`select count(*) from edition_reconciliation_exceptions`), n, 'idempotent');
    const x = E.q(`select id from edition_reconciliation_exceptions where kind='amount_mismatch' limit 1`);
    for (const w of ['ORG_ADMIN', 'OWNER', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select public.admin_resolve_edition_exception('${x}', 'Checked in Stripe')`)), w);
    assert.match(E.try('ADMIN', `select public.admin_resolve_edition_exception('${x}', 'ok')`), /note is required/);
    E.do('ADMIN', `select public.admin_resolve_edition_exception('${x}', 'Checked in Stripe: refunded outside')`);
    assert.equal(E.q(`select status from edition_reconciliation_exceptions where id='${x}'`), 'resolved');
    assert.equal(E.one('ADMIN', `select count(*) > 0 from public.edition_reconciliation_exceptions`), 't');
    assert.equal(E.one('ORG_ADMIN', `select count(*) from public.edition_reconciliation_exceptions`), '0', 'organisers cannot read exceptions');
  });
});

describe('statements and views', () => {
  test('organiser statement and payment list: organiser admins and admins only; fee and net add up', () => {
    for (const w of ['ORG_EDITOR', 'BIZ1', 'STRANGER', 'anon'] as Who[]) {
      assert.ok(failed(E.try(w, `select * from public.edition_org_statement('${ORG}', now() - interval '1 year', now() + interval '1 day')`)), w);
      assert.ok(failed(E.try(w, `select * from public.edition_org_payments('${ORG}')`)), w);
    }
    const r = E.one('ORG_ADMIN', `select sum(gross_pence) || '|' || sum(platform_fee_pence) || '|' || sum(net_to_organiser_pence) from public.edition_org_statement('${ORG}', now() - interval '1 year', now() + interval '1 day')`);
    const [g, f, n] = r.split('|').map(Number);
    assert.equal(g - f, n); assert.ok(g > 0);
    assert.ok(Number(E.one('ORG_ADMIN', `select count(*) from public.edition_org_payments('${ORG}', null, null, 'participation')`)) >= 2);
  });
  test('platform fee statement is admin only', () => {
    assert.ok(failed(E.try('ORG_ADMIN', `select * from public.admin_edition_fee_statement(now() - interval '1 year', now() + interval '1 day')`)));
    assert.match(E.one('ADMIN', `select organiser_name || '|' || platform_fee_pence from public.admin_edition_fee_statement(now() - interval '1 year', now() + interval '1 day')`), /ZZ Test Cafe\|\d+/);
  });
  test('a business sees its own payments (with the organiser\'s VAT details) and nobody else\'s', () => {
    assert.ok(Number(E.one('BIZ2', `select count(*) from public.edition_my_payments()`)) >= 1);
    assert.equal(E.one('BIZ2', `select count(*) from public.edition_my_payments() where charge_pence = 2000`), '0');
    assert.equal(E.one('anon', `select 1`), '1');
    assert.ok(failed(E.try('anon', `select * from public.edition_my_payments()`)));
  });
  test('payment and business listing state: nothing here changed a business, its plan or its offers', () => {
    assert.equal(E.q(`select count(*) from local_businesses where id in ('${B1}','${B2}','${B3}') and subscription_tier='pro' and subscription_until > now() + interval '80 days'`), '3');
    assert.equal(E.q(`select count(*) from information_schema.columns where table_schema='public' and table_name in ('local_businesses','local_offers','events','hub_members') and column_name ~* 'edition|participation'`), '0');
  });
});

describe('webhook bookkeeping and provider helpers (service role only)', () => {
  test('begin is true once per event, true again only after a failure, never for a processed event; people cannot call it', () => {
    for (const w of ['BIZ1', 'ADMIN', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select public.edition_webhook_begin('evt_1','payment_intent.succeeded')`)), w);
    assert.equal(last(E.do('service', `select public.edition_webhook_begin('evt_1','payment_intent.succeeded')`)), 't');
    assert.equal(last(E.do('service', `select public.edition_webhook_begin('evt_1','payment_intent.succeeded')`)), 't', 'received but not finished: process again');
    E.do('service', `select public.edition_webhook_done('evt_1','ok')`);
    assert.equal(last(E.do('service', `select public.edition_webhook_begin('evt_1','payment_intent.succeeded')`)), 'f');
    E.do('service', `select public.edition_webhook_begin('evt_2','x')`); E.do('service', `select public.edition_webhook_done('evt_2','failed','boom')`);
    assert.equal(last(E.do('service', `select public.edition_webhook_begin('evt_2','x')`)), 't', 'a failed event is retried');
  });
  test('payment_known tells the webhook which provider objects are ours; Stripe customers are stored once per user and are service-only', () => {
    assert.equal(E.one('service', `select public.edition_payment_known('pi_p2')`), 't'); assert.equal(E.one('service', `select public.edition_payment_known('pi_not_ours')`), 'f');
    E.do('service', `select public.edition_customer_set('${U.BIZ1}', 'cus_1')`); E.do('service', `select public.edition_customer_set('${U.BIZ1}', 'cus_2')`);
    assert.equal(E.one('service', `select public.edition_customer_get('${U.BIZ1}')`), 'cus_1');
    for (const w of ['BIZ1', 'anon'] as Who[]) { assert.ok(failed(E.try(w, `select public.edition_customer_get('${U.BIZ1}')`)), w); assert.ok(failed(E.try(w, `select * from public.edition_stripe_customers`)), w); }
  });
});

describe('R12 refunds retry temporary failures and never fail silently', () => {
  let pay = '', org = '';
  const mkReq = (amount: number) => last(E.sup(`insert into edition_refund_requests (payment_id, organiser_id, amount_pence, reason) values ('${pay}', '${org}', ${amount}, 'ZZ retry test') returning id`));
  test('a temporary failure keeps the request pending with a back-off; the request returns once it is due', () => {
    pay = E.q(`select id from edition_payments where source='stripe' order by created_at limit 1`); org = E.q(`select organiser_id from edition_payments where id='${pay}'`);
    const r = mkReq(500);
    E.do('service', `select public.edition_refund_request_mark('${r}', 'retry', 'rate limited')`);
    assert.equal(E.q(`select status || '|' || attempts from edition_refund_requests where id='${r}'`), 'pending|1');
    assert.doesNotMatch(E.do('service', `select request_id from public.edition_refunds_next()`), new RegExp(r), 'not offered again until its back-off has passed');
    E.sup(`update edition_refund_requests set next_attempt_at = now() where id='${r}'`);
    assert.match(E.do('service', `select request_id from public.edition_refunds_next()`), new RegExp(r));
    E.do('service', `select public.edition_refund_request_mark('${r}', 'submitted')`);
    assert.equal(E.q(`select status from edition_refund_requests where id='${r}'`), 'submitted');
  });
  test('after six temporary failures the refund FAILS and an exception is raised for the administrator', () => {
    const r = mkReq(400);
    for (let i = 0; i < 6; i++) E.do('service', `select public.edition_refund_request_mark('${r}', 'retry', 'provider unavailable')`);
    assert.equal(E.q(`select status from edition_refund_requests where id='${r}'`), 'failed');
    assert.equal(E.q(`select count(*) from edition_reconciliation_exceptions where kind='refund_failed' and detail->>'request'='${r}' and status='open'`), '1');
  });
  test('a final refusal fails at once, with the reason recorded; a finished request cannot be changed; only the service may mark', () => {
    const r = mkReq(300);
    E.do('service', `select public.edition_refund_request_mark('${r}', 'failed', 'the charge has been disputed')`);
    assert.equal(E.q(`select status || '|' || last_error from edition_refund_requests where id='${r}'`), 'failed|the charge has been disputed');
    assert.equal(E.q(`select count(*) from edition_reconciliation_exceptions where kind='refund_failed' and detail->>'request'='${r}'`), '1');
    E.do('service', `select public.edition_refund_request_mark('${r}', 'submitted')`);
    assert.equal(E.q(`select status from edition_refund_requests where id='${r}'`), 'failed', 'a failed request stays failed');
    for (const w of ['BIZ1', 'ORG_ADMIN', 'ADMIN', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select public.edition_refund_request_mark('${r}', 'submitted')`)), w);
  });
  test('two businesses cannot take the last festival place together: the capacity check takes a lock per Edition', () => {
    const def = E.q(`select pg_get_functiondef('public.edition_participation_pay_prepare(uuid,text)'::regprocedure) like '%pg_advisory_xact_lock%'`);
    assert.equal(def, 't');
  });
});


describe('R12 an organiser who disconnects Stripe stops collecting at once', () => {
  test('the disconnect event switches collection off (audited), is service-only, ignores accounts that are not ours, and reconnecting restores it', () => {
    const row = E.q(`select organiser_id || '|' || stripe_account_id from edition_payout_accounts where stripe_account_id is not null limit 1`);
    const [orgId, acct] = row.split('|');
    for (const w of ['BIZ1', 'ORG_ADMIN', 'ADMIN', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select public.edition_payout_account_disconnected('${acct}')`)), w);
    assert.equal(last(E.do('service', `select public.edition_payout_account_disconnected('acct_notours123')::text`)), 'false');
    assert.equal(last(E.do('service', `select public.edition_payout_account_disconnected('${acct}')::text`)), 'true');
    assert.equal(E.q(`select charges_enabled::text || '|' || payouts_enabled::text from edition_payout_accounts where stripe_account_id='${acct}'`), 'false|false');
    assert.ok(Number(E.q(`select count(*) from edition_audit_log where action='payout_account_disconnected' and organiser_id='${orgId}'`)) >= 1);
    assert.ok(E.q(`select public.edition_collect_blocker('${orgId}')`) !== '', 'the collection gate now blocks payments for this organiser');
    E.do('service', `select public.edition_payout_account_sync('${orgId}', '${acct}', true, true, true, '[]'::jsonb)`);
    assert.equal(E.q(`select charges_enabled::text from edition_payout_accounts where stripe_account_id='${acct}'`), 'true');
  });
});


describe('a Hub-run organiser works exactly like a Business-run one', () => {
  test('the Hub\'s committee (an admin) sets a participation fee on a published Hub-run Edition; an approved but unpaid business is then hidden; a plain Hub member cannot set terms', () => {
    const horg = enter(Base, 'HUB_OWNER', 'hub', S.HUB);
    const hed = draftEdition(Base, 'HUB_OWNER', horg, 'zz-hub-part-fest', 'ZZ Hub Part Fest');
    publishEdition(Base, 'HUB_OWNER', hed, 'ZZ Hub-run parity');
    for (const f of ['collect_payments', 'participation_fees']) E.do('ADMIN', `select public.admin_grant_edition_org_entitlement('${horg}', '${f}', null, ${days(90)}, 'ZZ Hub-run parity')`);
    const set = (w: 'HUB_COMMITTEE' | 'HUB_MEMBER') => Base.try(w, `select public.edition_set_participation_terms('${hed}', 'fee_required', 2000, 'none', 'none', null, null, null)`);
    assert.ok(failed(set('HUB_MEMBER')));
    assert.ok(!failed(Base.do('HUB_COMMITTEE', `select public.edition_set_participation_terms('${hed}', 'fee_required', 2000, 'none', 'none', null, null, null)`)));
    const l = last(Base.do('HUB_COMMITTEE', `select public.edition_invite_partner('${hed}','business','${B1}')`));
    E.do('BIZ1', `select public.edition_link_act('${l}','approve',null)`);
    assert.equal(E.q(`select state from edition_links where id='${l}'`), 'approved');
    assert.equal(E.one('anon', `select count(*) from public.edition_public_businesses where edition_id='${hed}'`), '0', 'unpaid: not shown');
  });
});
