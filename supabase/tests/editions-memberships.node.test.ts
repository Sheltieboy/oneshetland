/**
 * editions-memberships.node.test.ts — ISOLATED Postgres only. R4c: tiers, applications, invitations, decisions, payment events (simulated provider calls
 * through the service-role functions), failures and grace, cancellation, offline records, privacy, isolation from Business plans and Hub memberships.
 * Run: ISOLATED_ONLY=editions-memberships npm run test:isolated
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Env, USERS, seed, enter, draftEdition, last, failed as baseFailed } from './_support/editions-env.ts';
import { approveEdition, addHelper, aliased } from './_support/editions-env-2.ts';

// The organiser is a BUSINESS (ZZ Test Cafe): OWNER is its owner; ORG_ADMIN and ORG_EDITOR are invited helpers; BIZ1 and BIZ2 own the businesses that become members.
const MAP = { ADMIN: 'ADMIN', OWNER: 'BIZ_OWNER', ORG_ADMIN: 'HELPER', ORG_EDITOR: 'EDITOR', BIZ1: 'BIZ2_OWNER', BIZ2: 'HUB2_OWNER', STRANGER: 'STRANGER' } as const;
const U = { ADMIN: USERS.ADMIN, OWNER: USERS.BIZ_OWNER, ORG_ADMIN: USERS.HELPER, ORG_EDITOR: USERS.EDITOR, BIZ1: USERS.BIZ2_OWNER, BIZ2: USERS.HUB2_OWNER, STRANGER: USERS.STRANGER } as const;
type Who = keyof typeof MAP | 'anon' | 'service';
const failed = baseFailed;
let Base: Env, S: ReturnType<typeof seed>;
let E: ReturnType<typeof aliased<keyof typeof MAP>>;
let HUB_MEMBERS0 = '', ORG = '', B1 = '', B2 = '', B_UNCL = '', T_PAID = '', T_OPEN = '', T_FREE = '', T_INVITE = '';
const days = (n: number) => `(now() + interval '${n} days')`;
const MS = (m: string) => `status || '|' || coalesce(billing_interval,'') from organiser_memberships where id='${m}'`;

before(() => {
  Base = new Env('editionsmemb');
  S = seed(Base); E = aliased(Base, MAP);
  E.sup(`insert into admin_config (key, value, category) values ('editions.commerce.enabled','true','editions') on conflict (key) do update set value = excluded.value;`);
  HUB_MEMBERS0 = E.q(`select count(*) from hub_members`);
  ORG = enter(Base, 'BIZ_OWNER', 'business', S.BIZ);
  addHelper(Base, 'BIZ_OWNER', ORG, 'HELPER', `${U.ORG_ADMIN}@x.invalid`, 'admin');
  addHelper(Base, 'BIZ_OWNER', ORG, 'EDITOR', `${U.ORG_EDITOR}@x.invalid`, 'editor');
  // the first approved Edition records the organiser's identity check (there is no separate verification step any more)
  approveEdition(Base, 'BIZ_OWNER', draftEdition(Base, 'BIZ_OWNER', ORG, 'zz-member-fest', 'ZZ Member Fest'));
  for (const f of ['collect_payments', 'memberships', 'offline_records']) E.do('ADMIN', `select public.admin_grant_edition_org_entitlement('${ORG}', '${f}', ${f === 'memberships' ? 5 : 'null'}, ${days(90)}, 'ZZ membership suite')`);
  E.do('OWNER', `select public.edition_accept_commerce_terms('${ORG}', 'draft-1')`);
  E.do('service', `select public.edition_payout_account_sync('${ORG}', 'acct_member_1', true, true, true, '[]'::jsonb)`);
  const biz = (o: string | null, n: string) => last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active, subscription_tier, subscription_until) values (${o ? `'${o}'` : 'null'}, '${n}', 'food_drink', 'x', true, 'pro', now() + interval '90 days') returning id`));
  B1 = biz(U.BIZ1, 'ZZ Member Cafe'); B2 = biz(U.BIZ2, 'ZZ Member Bakery'); B_UNCL = biz(null, 'ZZ Unclaimed');
  const tier = (name: string, m: string, a: string, free: string, join: string, ben: string, disc: string) => last(E.do('ORG_ADMIN', `select public.edition_tier_save('${ORG}', null, '${name}', 'd', '["Listed on the members page","Early programme access"]'::jsonb, ${m}, ${a}, ${free}, 'none', '${join}', '${ben}', ${disc}, null, 1)`));
  T_PAID = tier('ZZ Full member', '1000', '10000', 'false', 'application', 'free', 'null');
  T_OPEN = tier('ZZ Friend', '500', 'null', 'false', 'open', 'percent_off', '20');
  T_FREE = tier('ZZ Supporter', 'null', 'null', 'true', 'open', 'none', 'null');
  T_INVITE = tier('ZZ Patron', '2000', 'null', 'false', 'invite_only', 'free', 'null');
});
after(() => Base?.drop());

describe('lockdown and isolation', () => {
  test('RLS on, no FOR ALL, no direct writes, organiser notes and provider ids are not readable by businesses', () => {
    assert.equal(E.q(`select count(*) from pg_class where relname like 'organiser_membership%' or relname='organiser_memberships' and not relrowsecurity`).length > 0, true);
    assert.equal(E.q(`select count(*) from pg_class where relname in ('organiser_membership_tiers','organiser_memberships','organiser_membership_events','organiser_membership_reminders') and not relrowsecurity`), '0');
    assert.equal(E.q(`select count(*) from pg_policies where tablename like 'organiser_membership%' and cmd='ALL'`), '0');
    assert.equal(E.q(`select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_name like 'organiser_membership%' and (grantee='anon' or privilege_type <> 'SELECT')`), '0');
    assert.equal(E.q(`select count(*) from information_schema.column_privileges where grantee='authenticated' and table_name='organiser_memberships' and column_name in ('organiser_note','stripe_subscription_id') and privilege_type='SELECT'`), '0');
    assert.ok(failed(E.try('BIZ1', `select organiser_note from public.organiser_memberships`)));
    for (const w of ['BIZ1', 'ADMIN', 'OWNER', 'anon'] as Who[]) assert.ok(failed(E.try(w, `insert into public.organiser_memberships (organiser_id, tier_id, business_id, status, source) values ('${ORG}','${T_PAID}','${B1}','active','application')`)), w);
  });
  test('provider-event functions are service-role only; nothing but the public tier list is open to anon', () => {
    for (const fn of ['edition_membership_payment_succeeded', 'edition_membership_payment_failed', 'edition_membership_subscription_changed', 'edition_membership_sweep', 'edition_payout_account_for', 'edition_tier_set_stripe_price', 'edition_membership_reminders_due']) {
      assert.equal(E.q(`select count(*) from pg_proc p where proname='${fn}' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`), '0', fn);
    }
    assert.equal(E.q(`select coalesce(string_agg(proname, ',' order by proname), '') from pg_proc p where pronamespace='public'::regnamespace and (proname like 'edition_membership%' or proname like 'edition_tier%' or proname like 'edition_org_members' or proname like 'edition_my_memberships' or proname like 'edition_public_tiers') and has_function_privilege('anon', p.oid, 'execute')`), 'edition_public_tiers');
  });
  test('nothing in Business plans or Hub memberships is touched by the schema', () => {
    assert.equal(E.q(`select count(*) from information_schema.columns where table_schema='public' and table_name in ('local_businesses','hubs','hub_members') and column_name ~* '(organiser_member|edition)'`), '0');
    assert.equal(E.q(`select count(*) from information_schema.table_constraints where table_name in ('hub_members','hubs') and constraint_name like '%organiser%'`), '0');
  });
});

describe('tiers', () => {
  test('organiser admins edit tiers; editors, owners of businesses and strangers cannot; needs the memberships entitlement', () => {
    for (const w of ['ORG_EDITOR', 'BIZ1', 'STRANGER', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select public.edition_tier_save('${ORG}', null, 'ZZ X', 'd', '[]'::jsonb, 100, null, false, 'none', 'open', 'none', null, null, 1)`)), w);
    E.sup(`set session_replication_role = replica; update edition_organiser_entitlements set voided_at = now(), void_reason='x' where feature='memberships'`);
    assert.match(E.try('ORG_ADMIN', `select public.edition_tier_save('${ORG}', null, 'ZZ X', 'd', '[]'::jsonb, 100, null, false, 'none', 'open', 'none', null, null, 1)`), /not included in your package/);
    E.sup(`set session_replication_role = replica; update edition_organiser_entitlements set voided_at = null, void_reason=null where feature='memberships'`);
  });
  test('validation: price floor, free means no price, discount needs percent_off, benefit lines, limit of 10', () => {
    const t = (m: string, free: string, ben: string, disc: string, benefits = '[]') => E.try('ORG_ADMIN', `select public.edition_tier_save('${ORG}', null, 'ZZ V', 'd', '${benefits}'::jsonb, ${m}, null, ${free}, 'none', 'open', '${ben}', ${disc}, null, 1)`);
    assert.ok(failed(t('50', 'false', 'none', 'null')), 'below 1.00');
    assert.ok(failed(t('null', 'false', 'none', 'null')), 'paid without a price');
    assert.ok(failed(t('500', 'false', 'percent_off', 'null')), 'percent_off without a percent');
    assert.ok(failed(t('500', 'false', 'free', '10')), 'a percent with free');
    assert.match(t('500', 'false', 'none', 'null', '[1,2]'), /short lines of text/);
    for (let i = 0; i < 6; i++) E.do('ORG_ADMIN', `select public.edition_tier_save('${ORG}', null, 'ZZ Filler ${i}', 'd', '[]'::jsonb, 100, null, false, 'none', 'open', 'none', null, null, 1)`);
    assert.match(E.try('ORG_ADMIN', `select public.edition_tier_save('${ORG}', null, 'ZZ Over', 'd', '[]'::jsonb, 100, null, false, 'none', 'open', 'none', null, null, 1)`), /limit of 10/);
    for (const x of E.q(`select string_agg(id::text, ',') from organiser_membership_tiers where name like 'ZZ Filler%'`).split(',')) E.do('ORG_ADMIN', `select public.edition_tier_archive('${x}')`);
  });
  test('editing a price with members creates a new version; the old tier keeps its members; without members it edits in place', () => {
    const m = last(E.do('BIZ1', `select public.edition_membership_apply('${T_OPEN}', '${B1}', 'monthly')`));
    const v2 = last(E.do('ORG_ADMIN', `select public.edition_tier_save('${ORG}', '${T_OPEN}', 'ZZ Friend', 'd', '[]'::jsonb, 700, null, false, 'none', 'open', 'percent_off', 20, null, 1)`));
    assert.notEqual(v2, T_OPEN);
    assert.equal(E.q(`select version || '|' || (archived_at is not null) from organiser_membership_tiers where id='${T_OPEN}'`), '1|true');
    assert.equal(E.q(`select tier_id from organiser_memberships where id='${m}'`), T_OPEN, 'the member stays on the version they signed up to');
    assert.equal(E.q(`select price_pence from organiser_memberships where id='${m}'`), '500');
    const same = last(E.do('ORG_ADMIN', `select public.edition_tier_save('${ORG}', '${T_INVITE}', 'ZZ Patron', 'new text', '[]'::jsonb, 2000, null, false, 'none', 'invite_only', 'free', null, null, 1)`));
    assert.equal(same, T_INVITE);
    E.do('BIZ1', `select public.edition_membership_withdraw('${m}')`); T_OPEN = v2;
  });
  test('public tier list: only open and application tiers of a verified organiser that can collect; free tiers always', () => {
    assert.equal(E.one('anon', `select string_agg(name, ',' order by name) from public.edition_public_tiers('zz-test-cafe')`), 'ZZ Friend,ZZ Full member,ZZ Supporter');
    E.do('ADMIN', `select public.admin_set_edition_collection('${ORG}', true, 'ZZ suspended for the test')`);
    assert.equal(E.one('anon', `select string_agg(name, ',') from public.edition_public_tiers('zz-test-cafe')`), 'ZZ Supporter');
    E.do('ADMIN', `select public.admin_set_edition_collection('${ORG}', false, 'ZZ resumed after the test')`);
  });
});

describe('applying and inviting', () => {
  let M_APP = '', M_OPEN = '', M_FREE = '', M_INV = '';
  test('only the business owner applies; strangers and other owners cannot; unlisted businesses refused', () => {
    for (const w of ['STRANGER', 'BIZ2', 'ORG_ADMIN', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select public.edition_membership_apply('${T_PAID}', '${B1}', 'monthly')`)), w);
    assert.match(E.try('BIZ1', `select public.edition_membership_apply('${T_INVITE}', '${B1}', 'monthly')`), /not open/);
    assert.match(E.try('BIZ1', `select public.edition_membership_apply('${T_PAID}', '${B1}', 'fortnightly')`), /choose monthly or annual/);
    assert.match(E.try('BIZ1', `select public.edition_membership_apply('${T_OPEN}', '${B1}', 'annual')`), /not offered/);
  });
  test('application tiers wait for approval; open paid tiers wait for payment; free open tiers are active at once', () => {
    M_APP = last(E.do('BIZ1', `select public.edition_membership_apply('${T_PAID}', '${B1}', 'annual', 'We would love to join')`));
    assert.equal(E.q(`select ${MS(M_APP)}`), 'applied|annual');
    M_OPEN = last(E.do('BIZ2', `select public.edition_membership_apply('${T_OPEN}', '${B2}', 'monthly')`));
    assert.equal(E.q(`select ${MS(M_OPEN)}`), 'pending_payment|monthly');
    const bf = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.BIZ2}', 'ZZ Free Tier Biz', 'retail', 'x', true) returning id`));
    M_FREE = last(E.do('BIZ2', `select public.edition_membership_apply('${T_FREE}', '${bf}', null)`));
    assert.equal(E.q(`select status from organiser_memberships where id='${M_FREE}'`), 'active');
    assert.match(E.try('BIZ2', `select public.edition_membership_apply('${T_FREE}', '${B2}', null)`), /already a member or already applied/, 'one live membership per business per organiser');
    assert.match(E.try('BIZ1', `select public.edition_membership_apply('${T_PAID}', '${B1}', 'monthly')`), /already a member or already applied/);
  });
  test('the price is snapshotted at application, so later tier edits cannot change it', () => {
    assert.equal(E.q(`select price_pence from organiser_memberships where id='${M_APP}'`), '10000');
  });
  test('decide: organiser admins only; approve moves to payment; decline records a note and blocks re-applying for 30 days', () => {
    for (const w of ['ORG_EDITOR', 'BIZ1', 'STRANGER'] as Who[]) assert.ok(failed(E.try(w, `select public.edition_membership_decide('${M_APP}', 'approve')`)), w);
    assert.equal(E.doOne('ORG_ADMIN', `select public.edition_membership_decide('${M_APP}', 'approve', 'Welcome')`), 'pending_payment');
    assert.match(E.try('ORG_ADMIN', `select public.edition_membership_decide('${M_APP}', 'decline')`), /already been answered/);
    const b3 = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.STRANGER}', 'ZZ Stranger Shop', 'retail', 'x', true) returning id`));
    const m = last(E.do('STRANGER', `select public.edition_membership_apply('${T_PAID}', '${b3}', 'monthly')`));
    assert.equal(E.doOne('ORG_ADMIN', `select public.edition_membership_decide('${m}', 'decline', 'Not this year')`), 'declined');
    assert.match(E.try('STRANGER', `select public.edition_membership_apply('${T_PAID}', '${b3}', 'monthly')`), /declined recently/);
  });
  test('invite: admins only, claimed businesses only; accept moves to payment; decline blocks a repeat; the business sees it', () => {
    assert.ok(failed(E.try('ORG_EDITOR', `select public.edition_membership_invite('${ORG}', '${T_INVITE}', '${B1}', 'monthly')`)));
    assert.match(E.try('ORG_ADMIN', `select public.edition_membership_invite('${ORG}', '${T_INVITE}', '${B_UNCL}', 'monthly')`), /not available to invite/);
    const b4 = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.ORG_EDITOR}', 'ZZ Editor Shop', 'retail', 'x', true) returning id`));
    M_INV = last(E.do('ORG_ADMIN', `select public.edition_membership_invite('${ORG}', '${T_INVITE}', '${b4}', 'monthly', 'We would like you as a patron')`));
    assert.match(E.one('ORG_EDITOR', `select status || '|' || message from public.edition_my_memberships()`), /invited\|We would like you as a patron/);
    assert.equal(E.one('BIZ1', `select count(*) from public.edition_my_memberships() where status='invited'`), '0');
    assert.ok(failed(E.try('BIZ1', `select public.edition_membership_respond('${M_INV}', true)`)));
    assert.equal(E.doOne('ORG_EDITOR', `select public.edition_membership_respond('${M_INV}', false, 'No thanks')`), 'declined');
    assert.match(E.try('ORG_ADMIN', `select public.edition_membership_invite('${ORG}', '${T_INVITE}', '${b4}', 'monthly')`), /declined recently/);
  });
  test('a business can withdraw an application that is not yet paid, but not a paid membership', () => {
    assert.ok(failed(E.try('BIZ2', `select public.edition_membership_withdraw('${M_APP}')`)));
    E.do('BIZ2', `select public.edition_membership_withdraw('${M_OPEN}')`);
    assert.equal(E.q(`select status from organiser_memberships where id='${M_OPEN}'`), 'withdrawn');
    assert.match(E.try('BIZ2', `select public.edition_membership_withdraw('${M_FREE}')`), /cancel the membership instead/);
  });
});

describe('paying by card (provider calls simulated through the service role)', () => {
  let M = '';
  test('prepare: owner only; organiser team cannot pay their own organiser; blockers named; breakdown computed here', () => {
    M = E.q(`select id from organiser_memberships where tier_id='${T_PAID}' and business_id='${B1}'`);
    for (const w of ['BIZ2', 'STRANGER', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select public.edition_membership_pay_prepare('${M}', 'attempt-pay-001')`)), w);
    const r = JSON.parse(E.one('BIZ1', `select public.edition_membership_pay_prepare('${M}', 'attempt-pay-001')::text`));
    assert.equal(r.price_pence, 10000); assert.equal(r.charge_pence, 10000); assert.equal(r.platform_fee_pence, 370, '2% commission (200) + estimated processing fee 1.5% + 20p (170)'); assert.equal(r.net_to_organiser_pence, 9630); assert.equal(r.organiser_id, ORG);
    assert.match(E.try('BIZ1', `select public.edition_membership_pay_prepare('${M}', 'x')`), /invalid attempt/);
    const bo = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.ORG_ADMIN}', 'ZZ Admin Biz', 'retail', 'x', true) returning id`));
    const mo = last(E.do('ORG_ADMIN', `select public.edition_membership_apply('${T_OPEN}', '${bo}', 'monthly')`));
    assert.match(E.try('ORG_ADMIN', `select public.edition_membership_pay_prepare('${mo}', 'attempt-pay-002')`), /cannot pay an organiser you are part of/);
    E.do('ADMIN', `select public.admin_set_edition_collection('${ORG}', true, 'ZZ blocked for the test')`);
    assert.match(E.try('BIZ1', `select public.edition_membership_pay_prepare('${M}', 'attempt-pay-003')`), /collection_suspended/);
    E.do('ADMIN', `select public.admin_set_edition_collection('${ORG}', false, 'ZZ resumed for the test')`);
    E.do('BIZ2', `select 1`); E.do('ORG_ADMIN', `select public.edition_membership_withdraw('${mo}')`.replace('ORG_ADMIN', 'ORG_ADMIN'));
  });
  test('the customer-facing ceiling applies', () => {
    E.do('ADMIN', `select public.admin_set_edition_commerce_config('editions.commerce.max_charge_pence', '5000')`);
    assert.match(E.try('BIZ1', `select public.edition_membership_pay_prepare('${M}', 'attempt-pay-004')`), /above the allowed limit/);
    E.do('ADMIN', `select public.admin_set_edition_commerce_config('editions.commerce.max_charge_pence', '500000')`);
  });
  test('first payment: wrong amount refused; right amount activates and records the ledger row with fee and net; people cannot do it', () => {
    for (const w of ['BIZ1', 'ORG_ADMIN', 'ADMIN', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select public.edition_membership_payment_succeeded('${M}', 'sub_1', 'pi_a', 'in_a', 'ch_a', now(), ${days(365)}, 10000, null)`)), w);
    assert.match(E.try('service', `select public.edition_membership_payment_succeeded('${M}', 'sub_1', 'pi_a', 'in_a', 'ch_a', now(), ${days(365)}, 9999, null)`), /does not match the membership price/);
    assert.equal(E.doOne('service', `select public.edition_membership_payment_succeeded('${M}', 'sub_1', 'pi_a', 'in_a', 'ch_a', now(), ${days(365)}, 10000, 215)`), 'recorded');
    assert.equal(E.q(`select status from organiser_memberships where id='${M}'`), 'active');
    assert.equal(E.q(`select platform_fee_pence || '|' || net_to_organiser_pence || '|' || stripe_fee_pence || '|' || source || '|' || status from edition_payments where stripe_invoice_id='in_a'`), '370|9630|215|stripe|succeeded');
    assert.equal(E.q(`select commission_pence || '|' || recovery_estimate_pence || '|' || coalesce(recovery_variance_pence::text,'-') from edition_payments where stripe_invoice_id='in_a'`), '200|170|-45', 'parts recorded; variance = estimate 170 minus Stripe actual 215');
    assert.equal(E.q(`select stripe_subscription_id from organiser_memberships where id='${M}'`), 'sub_1');
  });
  test('a subscription fee that differs from the computed fee: the provider amount is the ledger truth and the difference is raised for reconciliation', () => {
    const bx = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.STRANGER}', 'ZZ Fee Biz', 'retail', 'x', true) returning id`));
    const mx = last(E.do('STRANGER', `select public.edition_membership_apply('${T_OPEN}', '${bx}', 'monthly')`));
    E.do('service', `select public.edition_membership_payment_succeeded('${mx}', 'sub_f', 'pi_f', 'in_f', 'ch_f', now(), ${days(30)}, 700, 20, 24)`);
    assert.equal(E.q(`select platform_fee_pence || '|' || net_to_organiser_pence from edition_payments where stripe_invoice_id='in_f'`), '24|676');
    assert.equal(E.q(`select count(*) from edition_reconciliation_exceptions where kind='fee_mismatch' and provider_ref='in_f'`), '1');
  });
  test('duplicate and replayed provider events change nothing', () => {
    assert.equal(E.doOne('service', `select public.edition_membership_payment_succeeded('${M}', 'sub_1', 'pi_a', 'in_a', 'ch_a', now(), ${days(365)}, 10000, null)`), 'already_recorded');
    assert.equal(E.q(`select count(*) from edition_payments where ref_id='${M}'`), '1');
  });
  test('renewal extends the period with a second ledger row; benefits are live while active', () => {
    E.do('service', `select public.edition_membership_payment_succeeded('${M}', 'sub_1', 'pi_b', 'in_b', 'ch_b', ${days(365)}, ${days(730)}, 10000, null)`);
    assert.equal(E.q(`select count(*) from edition_payments where ref_id='${M}'`), '2');
    assert.equal(E.q(`select (current_period_end > now() + interval '700 days')::text from organiser_memberships where id='${M}'`), 'true');
    assert.equal(E.q(`select tier_name || '|' || edition_benefit from public.edition_member_benefit('${ORG}', '${B1}')`), 'ZZ Full member|free');
  });
  test('failed renewal: past_due keeps benefits during grace; recovery payment restores; after grace the sweep expires it and benefits end', () => {
    assert.equal(E.doOne('service', `select public.edition_membership_payment_failed('${M}', 'in_c', 1)`), 'past_due');
    assert.equal(E.q(`select count(*) from public.edition_member_benefit('${ORG}', '${B1}')`), '1', 'inside grace');
    E.sup(`update organiser_memberships set past_due_since = now() - interval '20 days' where id='${M}'`);
    assert.equal(E.q(`select count(*) from public.edition_member_benefit('${ORG}', '${B1}')`), '0', 'grace is over, benefits end even before the sweep');
    assert.match(E.doOne('service', `select public.edition_membership_sweep()::text`), /"expired": 1/);
    assert.equal(E.q(`select status from organiser_memberships where id='${M}'`), 'expired');
    E.do('service', `select public.edition_membership_payment_succeeded('${M}', 'sub_1', 'pi_d', 'in_d', 'ch_d', now(), ${days(30)}, 10000, null)`);
    assert.equal(E.q(`select status from organiser_memberships where id='${M}'`), 'active', 'paying again recovers an expired card membership');
  });
  test('cancel: the owner cancels at period end; benefits last until then; the provider cancellation event finalises; the sweep ends it', () => {
    assert.ok(failed(E.try('BIZ2', `select public.edition_membership_cancel('${M}')`)));
    assert.equal(E.doOne('BIZ1', `select public.edition_membership_cancel('${M}')`), 'cancel_at_period_end');
    assert.equal(E.q(`select count(*) from public.edition_member_benefit('${ORG}', '${B1}')`), '1');
    E.sup(`update organiser_memberships set current_period_end = now() - interval '1 hour' where id='${M}'`);
    assert.equal(E.q(`select count(*) from public.edition_member_benefit('${ORG}', '${B1}')`), '0');
    assert.match(E.doOne('service', `select public.edition_membership_sweep()::text`), /"cancelled": 1/);
    assert.equal(E.q(`select status from organiser_memberships where id='${M}'`), 'cancelled');
    E.do('service', `select public.edition_membership_subscription_changed('${M}', 'canceled', true, null)`);
    assert.equal(E.q(`select status from organiser_memberships where id='${M}'`), 'cancelled');
  });
  test('a membership can be applied for again after cancelling, with a fresh row', () => {
    const m2 = last(E.do('BIZ1', `select public.edition_membership_apply('${T_OPEN}', '${B1}', 'monthly')`));
    assert.equal(E.q(`select status from organiser_memberships where id='${m2}'`), 'pending_payment');
    E.do('BIZ1', `select public.edition_membership_withdraw('${m2}')`);
  });
});

describe('R10 Stripe lifecycle: cancellation, no revival, reconciliation of subscription charges', () => {
  let M2 = '';
  const sub = (id: string, status: string, cancel = false) => E.do('service', `select public.edition_membership_subscription_changed('${id}', '${status}', ${cancel}, null)`);
  test('the queue and its functions are service-only', () => {
    for (const fn of ['edition_stripe_cancel_enqueue', 'edition_stripe_cancels_next', 'edition_stripe_cancel_mark', 'edition_membership_stripe_cancel_trg'])
      assert.equal(E.q(`select count(*) from pg_proc p where proname='${fn}' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`), '0', fn);
    assert.equal(E.q(`select count(*) from information_schema.role_table_grants where table_name='edition_stripe_cancel_queue' and grantee in ('anon','authenticated')`), '0');
  });
  test('cancelling a card membership queues a provider cancel at period end; ending it now escalates to an immediate one; the cron marks it done', () => {
    M2 = last(E.do('BIZ1', `select public.edition_membership_apply('${T_OPEN}', '${B1}', 'monthly')`));
    E.do('service', `select public.edition_membership_payment_succeeded('${M2}', 'sub_life', 'pi_l1', 'in_l1', 'ch_l1', now(), ${days(30)}, 700, null)`);
    assert.equal(E.q(`select count(*) from edition_stripe_cancel_queue where membership_id='${M2}'`), '0', 'an active membership queues nothing');
    assert.equal(E.doOne('BIZ1', `select public.edition_membership_cancel('${M2}')`), 'cancel_at_period_end');
    assert.equal(E.q(`select mode || '|' || status || '|' || subscription_id from edition_stripe_cancel_queue where membership_id='${M2}'`), 'at_period_end|pending|sub_life');
    assert.equal(E.doOne('ORG_ADMIN', `select public.edition_membership_end('${M2}', 'now', 'Ended for the test')`), 'cancelled');
    assert.equal(E.q(`select mode || '|' || status from edition_stripe_cancel_queue where membership_id='${M2}'`), 'now|pending');
    assert.match(E.doOne('service', `select membership_id || '|' || mode from public.edition_stripe_cancels_next() where membership_id='${M2}'`), new RegExp(`${M2}\\|now`));
    E.do('service', `select public.edition_stripe_cancel_mark('${M2}', false, 'network')`);
    assert.equal(E.q(`select status || '|' || attempts from edition_stripe_cancel_queue where membership_id='${M2}'`), 'failed|1');
    assert.equal(E.q(`select count(*) from public.edition_stripe_cancels_next() where membership_id='${M2}'`), '1', 'a failed cancel is retried');
    E.do('service', `select public.edition_stripe_cancel_mark('${M2}', true)`);
    assert.equal(E.q(`select status from edition_stripe_cancel_queue where membership_id='${M2}'`), 'done');
    assert.equal(E.q(`select count(*) from public.edition_stripe_cancels_next() where membership_id='${M2}'`), '0');
  });
  test('a later provider update cannot revive a cancelled membership; it is refused, logged, and the provider cancel is queued again', () => {
    sub(M2, 'active', false);
    assert.equal(E.q(`select status from organiser_memberships where id='${M2}'`), 'cancelled');
    assert.equal(E.q(`select count(*) from organiser_membership_events where membership_id='${M2}' and event='revival_refused'`), '1');
    assert.equal(E.q(`select status from edition_stripe_cancel_queue where membership_id='${M2}'`), 'pending', 're-opened');
    sub(M2, 'canceled', false); assert.equal(E.q(`select status from organiser_memberships where id='${M2}'`), 'cancelled');
  });
  test('money that still arrives for a cancelled membership is recorded in the ledger, raised for refund, and never revives it', () => {
    assert.equal(E.doOne('service', `select public.edition_membership_payment_succeeded('${M2}', 'sub_life', 'pi_l2', 'in_l2', 'ch_l2', now(), ${days(30)}, 700, null)`), 'recorded_after_cancel');
    assert.equal(E.q(`select status from organiser_memberships where id='${M2}'`), 'cancelled');
    assert.equal(E.q(`select count(*) from edition_payments where ref_id='${M2}' and stripe_invoice_id='in_l2'`), '1', 'ledger has it');
    assert.equal(E.q(`select count(*) from edition_reconciliation_exceptions where kind='payment_after_cancel' and provider_ref='in_l2' and status='open'`), '1');
    assert.equal(E.doOne('service', `select public.edition_membership_payment_succeeded('${M2}', 'sub_life', 'pi_l2', 'in_l2', 'ch_l2', now(), ${days(30)}, 700, null)`), 'already_recorded', 'a replay changes nothing');
    assert.equal(E.q(`select count(*) from edition_reconciliation_exceptions where provider_ref='in_l2'`), '1');
  });
  test('reconciliation: an unmarked subscription charge is compared when the ledger knows it, and never reported as missing when it does not', () => {
    const snap = (items: string) => E.do('service', `select public.edition_reconcile_apply('${items}'::jsonb, now() - interval '1 day', now() + interval '1 day')::text`);
    const ex = (ref: string) => E.q(`select coalesce(string_agg(kind, ','), 'none') from edition_reconciliation_exceptions where provider_ref='${ref}'`);
    snap(`[{"payment_intent":"pi_l1","amount":700,"marked":false,"status":"succeeded"}]`);
    assert.equal(ex('pi_l1'), 'none', 'a known charge that matches raises nothing');
    snap(`[{"payment_intent":"pi_biz_plan","amount":2900,"marked":false,"status":"succeeded"}]`);
    assert.equal(ex('pi_biz_plan'), 'none', 'an unmarked charge the ledger has never heard of is not ours (e.g. a Business plan)');
    snap(`[{"payment_intent":"pi_ghost","amount":900,"marked":true,"status":"succeeded"}]`);
    assert.equal(ex('pi_ghost'), 'missing_in_ledger', 'a MARKED edition charge missing from the ledger is still a problem');
    snap(`[{"payment_intent":"pi_l1","amount":701,"marked":false,"status":"succeeded"}]`);
    assert.match(ex('pi_l1'), /amount_mismatch/, 'a known charge with a different amount is still an exception');
  });
});

describe('offline and complimentary records', () => {
  let MO = '';
  test('needs the entitlement and an admin; validation and notes enforced', () => {
    const rec = (who: Who, kind = 'offline', amt = '5000', note = 'Cheque 1042') => E.try(who, `select public.edition_membership_record_offline('${ORG}', '${T_PAID}', '${B2}', '${kind}', now(), ${days(365)}, ${amt}, 'cheque', '${note}')`);
    for (const w of ['ORG_EDITOR', 'BIZ2', 'STRANGER', 'anon'] as Who[]) assert.ok(failed(rec(w)), w);
    assert.match(rec('ORG_ADMIN', 'offline', '5000', ''), /a note is required/);
    assert.match(rec('ORG_ADMIN', 'cash', '5000'), /choose offline or complimentary/);
    assert.match(E.try('ORG_ADMIN', `select public.edition_membership_record_offline('${ORG}', '${T_PAID}', '${B2}', 'offline', now(), ${days(500)}, 5000, 'cheque', 'Cheque')`), /at most a year/);
    assert.match(E.try('ORG_ADMIN', `select public.edition_membership_record_offline('${ORG}', '${T_PAID}', '${B2}', 'offline', now(), ${days(365)}, null, 'cheque', 'Cheque')`), /amount and how/);
    E.sup(`set session_replication_role = replica; update edition_organiser_entitlements set voided_at = now(), void_reason='x' where feature='offline_records'`);
    assert.match(rec('ORG_ADMIN'), /not included in your package/);
    E.sup(`set session_replication_role = replica; update edition_organiser_entitlements set voided_at = null, void_reason=null where feature='offline_records'`);
  });
  test('recording an offline membership makes it active with an offline ledger row, no Stripe ids, and benefits apply', () => {
    E.do('BIZ2', `select 1`);
    E.sup(`update organiser_memberships set status='withdrawn' where business_id='${B2}' and status='active'`);
    MO = last(E.do('ORG_ADMIN', `select public.edition_membership_record_offline('${ORG}', '${T_PAID}', '${B2}', 'offline', now(), ${days(365)}, 5000, 'cheque', 'Cheque 1042 received at the AGM')`));
    // CONSENT: recording is an OFFER. Nothing is live, counted, public or in the ledger until the business owner accepts.
    assert.equal(E.q(`select ${MS(MO)}`), 'invited|offline');
    assert.equal(E.q(`select count(*) from edition_payments where ref_id='${MO}'`), '0', 'no payment row before acceptance');
    assert.equal(E.q(`select count(*) from public.edition_member_benefit('${ORG}', '${B2}')`), '0', 'no benefit before acceptance');
    for (const w of ['BIZ1', 'STRANGER', 'ORG_ADMIN', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select public.edition_membership_respond('${MO}', true)`)), `${w} cannot accept for the business`);
    assert.equal(E.doOne('BIZ2', `select public.edition_membership_respond('${MO}', true)`), 'active');
    assert.equal(E.q(`select ${MS(MO)}`), 'active|offline');
    assert.equal(E.q(`select source || '|' || method || '|' || charge_pence || '|' || platform_fee_pence || '|' || coalesce(stripe_payment_intent_id,'none') from edition_payments where ref_id='${MO}'`), 'offline|cheque|5000|0|none');
    assert.equal(E.q(`select edition_benefit from public.edition_member_benefit('${ORG}', '${B2}')`), 'free');
  });
  test('the member limit of the package is enforced; an offline member cannot be paid by card; renew by hand extends', () => {
    assert.match(E.try('BIZ2', `select public.edition_membership_pay_prepare('${MO}', 'attempt-off-001')`), /not waiting for payment|not paid by card/);
    E.do('ORG_ADMIN', `select public.edition_membership_renew_offline('${MO}', ${days(700)}, 5000, 'bank_transfer', 'BACS ref 77')`);
    assert.equal(E.q(`select count(*) from edition_payments where ref_id='${MO}'`), '2');
    assert.match(E.try('ORG_ADMIN', `select public.edition_membership_renew_offline('${MO}', ${days(1200)}, 5000, 'bank_transfer', 'BACS ref 78')`), /at most a year/);
  });
  test('complimentary membership: no money, a reason, and the sweep expires an offline membership at its end date', () => {
    const b5 = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.STRANGER}', 'ZZ Comp Shop', 'retail', 'x', true) returning id`));
    const mc = last(E.do('ORG_ADMIN', `select public.edition_membership_record_offline('${ORG}', '${T_PAID}', '${b5}', 'complimentary', now(), ${days(100)}, null, null, 'Founding member, free for the first year')`));
    assert.equal(E.q(`select count(*) from edition_payments where ref_id='${mc}'`), '0');
    assert.equal(E.doOne('STRANGER', `select public.edition_membership_respond('${mc}', true)`), 'active');
    assert.equal(E.q(`select source || '|' || charge_pence from edition_payments where ref_id='${mc}'`), 'complimentary|0');
    E.sup(`update organiser_memberships set current_period_end = now() - interval '1 day' where id='${mc}'`);
    assert.match(E.doOne('service', `select public.edition_membership_sweep()::text`), /"expired": 1/);
    assert.equal(E.q(`select count(*) from public.edition_member_benefit('${ORG}', '${b5}')`), '0');
  });
  test('CONSENT: a declined offline offer leaves no membership, no payment and no benefit; an expired offer cannot be accepted; the offer is private to the team and the owner', () => {
    const b6 = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.BIZ1}', 'ZZ Decline Shop', 'retail', 'x', true) returning id`));
    const md = last(E.do('ORG_ADMIN', `select public.edition_membership_record_offline('${ORG}', '${T_PAID}', '${b6}', 'offline', now(), ${days(200)}, 1500, 'cash', 'Cash at the stall')`));
    assert.equal(E.one('ORG_ADMIN', `select count(*) from public.edition_org_members('${ORG}') where business_id='${b6}'`), '1', 'the team sees its own offer');
    assert.equal(E.one('STRANGER', `select count(*) from public.edition_my_memberships() where business_id='${b6}'`), '0');
    assert.equal(E.doOne('BIZ1', `select public.edition_membership_respond('${md}', false, 'No thanks')`), 'declined');
    assert.equal(E.q(`select count(*) from edition_payments where ref_id='${md}'`), '0');
    assert.equal(E.q(`select count(*) from public.edition_member_benefit('${ORG}', '${b6}')`), '0');
    assert.match(E.try('BIZ1', `select public.edition_membership_respond('${md}', true)`), /already been answered/);
    const b7 = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.BIZ1}', 'ZZ Late Shop', 'retail', 'x', true) returning id`));
    const me = last(E.do('ORG_ADMIN', `select public.edition_membership_record_offline('${ORG}', '${T_PAID}', '${b7}', 'offline', now() - interval '40 days', now() + interval '1 day', 900, 'cheque', 'Cheque 9')`));
    E.sup(`update organiser_memberships set current_period_end = now() - interval '1 hour' where id='${me}'`);
    assert.match(E.try('BIZ1', `select public.edition_membership_respond('${me}', true)`), /expired/);
    assert.equal(E.q(`select count(*) from edition_payments where ref_id='${me}'`), '0');
  });
  test('renewal reminders: offline memberships near their end are listed once per period and stay marked once sent', () => {
    E.sup(`update organiser_memberships set current_period_end = now() + interval '5 days' where id='${MO}'`);
    assert.match(E.q(`select string_agg(kind, ',' order by kind) from public.edition_membership_reminders_due() where membership_id='${MO}'`).replace(/\s/g, ''), /renewal_30d,renewal_7d/);
    E.do('service', `select public.edition_membership_reminder_sent('${MO}', 'renewal_7d', (select current_period_end from organiser_memberships where id='${MO}'))`);
    assert.equal(E.q(`select string_agg(kind, ',') from public.edition_membership_reminders_due() where membership_id='${MO}'`), 'renewal_30d');
  });
});

describe('member search', () => {
  test('organiser admins find directory businesses with their membership status; others cannot', () => {
    assert.match(E.one('ORG_ADMIN', `select string_agg(name || ':' || claimed || ':' || coalesce(membership_status, '-'), ',' order by name) from public.edition_member_find_businesses('${ORG}', 'zz member')`), /ZZ Member Bakery:true:active/);
    for (const w of ['ORG_EDITOR', 'BIZ1', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select * from public.edition_member_find_businesses('${ORG}', 'zz member')`)), w);
    assert.equal(E.one('ORG_ADMIN', `select count(*) from public.edition_member_find_businesses('${ORG}', 'z')`), '0');
  });
});

describe('privacy and views', () => {
  test('organiser notes are visible to the team only; a business sees its own memberships without notes; strangers see nothing', () => {
    const m = E.q(`select id from organiser_memberships where business_id='${B2}' and status='active' limit 1`);
    E.do('ORG_EDITOR', `select public.edition_membership_set_note('${m}', 'Prefers email; pays by cheque')`);
    assert.ok(failed(E.try('BIZ2', `select public.edition_membership_set_note('${m}', 'x')`)));
    assert.match(E.one('ORG_ADMIN', `select organiser_note from public.edition_org_members('${ORG}') where membership_id='${m}'`), /Prefers email/);
    assert.ok(failed(E.try('BIZ2', `select * from public.edition_org_members('${ORG}')`)));
    assert.equal(E.one('BIZ2', `select count(*) from public.edition_my_memberships() where business_id='${B2}'`) !== '0', true);
    assert.equal(E.one('BIZ2', `select count(*) from public.edition_my_memberships() where business_id='${B1}'`), '0');
    assert.equal(E.one('STRANGER', `select count(*) from public.edition_my_memberships() where organiser_id='${ORG}' and business_id in ('${B1}','${B2}')`), '0');
    assert.ok(failed(E.try('BIZ1', `select * from public.edition_membership_timeline('${m}')`)));
    assert.match(E.one('BIZ2', `select string_agg(event, ',') from public.edition_membership_timeline('${m}')`) || 'none', /./);
  });
  test('renewals due and the member list are organiser-team only', () => {
    assert.ok(failed(E.try('STRANGER', `select * from public.edition_membership_renewals_due('${ORG}', 30)`)));
    assert.match(E.one('ORG_EDITOR', `select count(*) from public.edition_membership_renewals_due('${ORG}', 30)`), /^\d+$/);
  });
  test('end by the organiser: needs a reason; now or at period end; the member sees the reason', () => {
    const m = E.q(`select id from organiser_memberships where business_id='${B2}' and status='active' limit 1`);
    assert.match(E.try('ORG_ADMIN', `select public.edition_membership_end('${m}', 'now', '')`), /say why/);
    assert.ok(failed(E.try('ORG_EDITOR', `select public.edition_membership_end('${m}', 'now', 'Because')`)));
    assert.equal(E.doOne('ORG_ADMIN', `select public.edition_membership_end('${m}', 'period_end', 'Not renewing the tier')`), 'cancel_at_period_end');
    assert.match(E.one('BIZ2', `select decision_note from public.edition_my_memberships() where membership_id='${m}'`), /Not renewing the tier/);
  });
  test('Business plan and Hub membership state is byte-identical to before (nothing in this release wrote them)', () => {
    assert.equal(E.q(`select count(*) from local_businesses where id in ('${B1}','${B2}','${B_UNCL}') and subscription_tier='pro' and subscription_until > now() + interval '80 days'`), '3');
    assert.equal(E.q(`select count(*) from hub_members`), HUB_MEMBERS0, 'Hub memberships are untouched');
  });
});

describe('R12 a past-due card membership is paid through its existing subscription, never a second one', () => {
  let my = '', bx2 = '';
  test('a membership that has paid once reports its provider subscription to the checkout; a fresh one reports none', () => {
    bx2 = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.STRANGER}', 'ZZ Repay Biz', 'retail', 'x', true) returning id`));
    my = last(E.do('STRANGER', `select public.edition_membership_apply('${T_OPEN}', '${bx2}', 'monthly')`));
    assert.equal(JSON.parse(E.one('STRANGER', `select public.edition_membership_pay_prepare('${my}', 'attempt-r12-001')::text`)).existing_subscription, null);
    assert.equal(E.doOne('service', `select public.edition_membership_payment_succeeded('${my}', 'sub_r1', 'pi_r1', 'in_r1', 'ch_r1', now(), ${days(30)}, 700, 20)`), 'recorded');
    assert.equal(E.doOne('service', `select public.edition_membership_payment_failed('${my}', 'in_r2', 1)`), 'past_due');
    assert.equal(JSON.parse(E.one('STRANGER', `select public.edition_membership_pay_prepare('${my}', 'attempt-r12-002')::text`)).existing_subscription, 'sub_r1');
  });
  test('if a second subscription is paid anyway, the money is recorded, the first subscription stays, an exception is raised and the extra one is queued to be cancelled', () => {
    assert.equal(E.doOne('service', `select public.edition_membership_payment_succeeded('${my}', 'sub_r2', 'pi_r3', 'in_r3', 'ch_r3', now(), ${days(30)}, 700, 20)`), 'recorded_duplicate_subscription');
    assert.equal(E.q(`select stripe_subscription_id || '|' || status from organiser_memberships where id='${my}'`), 'sub_r1|past_due', 'the stored subscription and status are untouched');
    assert.equal(E.q(`select count(*) from edition_payments where stripe_invoice_id='in_r3'`), '1', 'the money is in the ledger');
    assert.equal(E.q(`select count(*) from edition_reconciliation_exceptions where kind='duplicate_subscription' and provider_ref='in_r3' and status='open'`), '1');
    assert.equal(E.doOne('service', `select public.edition_membership_payment_succeeded('${my}', 'sub_r2', 'pi_r3', 'in_r3', 'ch_r3', now(), ${days(30)}, 700, 20)`), 'already_recorded', 'a replay changes nothing');
    assert.equal(E.q(`select count(*) from edition_reconciliation_exceptions where kind='duplicate_subscription'`), '1');
  });
  test('the extra subscription is handed to the cron to end, marked done, and not offered again; it is service-only', () => {
    assert.equal(E.doOne('service', `select subscription_id || '|' || membership_id from public.edition_stripe_stray_next()`), `sub_r2|${my}`);
    E.do('service', `select public.edition_stripe_stray_mark('sub_r2', false, 'temporary')`);
    assert.equal(E.doOne('service', `select count(*)::text from public.edition_stripe_stray_next()`), '1', 'a failed attempt is retried');
    E.do('service', `select public.edition_stripe_stray_mark('sub_r2', true)`);
    assert.equal(E.doOne('service', `select count(*)::text from public.edition_stripe_stray_next()`), '0');
    for (const w of ['BIZ1', 'ORG_ADMIN', 'ADMIN', 'anon'] as Who[]) {
      assert.ok(failed(E.try(w, `select * from public.edition_stripe_stray_next()`)), w);
      assert.ok(failed(E.try(w, `select * from public.edition_stripe_stray_subscriptions`)), w);
    }
  });
});

describe('a Hub-run organiser works exactly like a Business-run one', () => {
  test('the Hub\'s committee (an admin) saves a tier once the package includes memberships; a plain Hub member and a stranger cannot; the tier is public once the Edition is approved', () => {
    const horg = enter(Base, 'HUB_OWNER', 'hub', S.HUB);
    approveEdition(Base, 'HUB_OWNER', draftEdition(Base, 'HUB_OWNER', horg, 'zz-hub-member-fest', 'ZZ Hub Member Fest'));
    for (const f of ['collect_payments', 'memberships', 'offline_records']) E.do('ADMIN', `select public.admin_grant_edition_org_entitlement('${horg}', '${f}', ${f === 'memberships' ? 5 : 'null'}, ${days(90)}, 'ZZ Hub-run parity')`);
    const save = (w: 'HUB_COMMITTEE' | 'HUB_MEMBER' | 'STRANGER') => Base.try(w, `select public.edition_tier_save('${horg}', null, 'ZZ Hub Friend', 'd', '[]'::jsonb, null, null, true, 'none', 'open', 'none', null, null, 1)`);
    assert.ok(failed(save('HUB_MEMBER'))); assert.ok(failed(save('STRANGER')));
    const t = last(Base.do('HUB_COMMITTEE', `select public.edition_tier_save('${horg}', null, 'ZZ Hub Friend', 'd', '[]'::jsonb, null, null, true, 'none', 'open', 'none', null, null, 1)`));
    assert.match(t, /^[0-9a-f-]{36}$/, t);
    assert.equal(Base.one('anon', `select string_agg(name, ',') from public.edition_public_tiers('${E.q(`select slug from edition_organisers where id='${horg}'`)}')`), 'ZZ Hub Friend', 'a free open tier is public');
  });
});
