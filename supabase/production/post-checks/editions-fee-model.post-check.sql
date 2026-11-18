-- Read-only post-check for 20270105000000_editions_fee_model (the Editions fee model and financial safeguards). Every row should say ok = true. NOT YET RUN ANYWHERE.
-- Run after applying, before switching payments on. The two rows about Stripe's rates are the reminder that the processing-cost estimate rates are PLACEHOLDERS until Darren confirms them.
select 'commission is 2% for participation and membership' as check,
  public.edition_commerce_cfg('editions.commerce.participation.fee_percent', '2')::numeric = 2 and public.edition_commerce_cfg('editions.commerce.membership.fee_percent', '2')::numeric = 2 as ok;
select 'the processing-cost estimate keys exist (placeholders: 1.5% + 20p) and are flagged unconfirmed until Darren confirms Stripe''s real rates' as check,
  (select count(*) from public.admin_config where key in ('editions.commerce.participation.stripe_cost_percent', 'editions.commerce.membership.stripe_cost_percent', 'editions.commerce.participation.stripe_cost_fixed_pence', 'editions.commerce.membership.stripe_cost_fixed_pence', 'editions.commerce.stripe_cost_confirmed')) = 5 as ok;
select 'RATES CONFIRMED before payments are switched on (fails if commerce is enabled while editions.commerce.stripe_cost_confirmed is not true)' as check,
  public.edition_commerce_cfg('editions.commerce.enabled', 'false') <> 'true' or public.edition_commerce_cfg('editions.commerce.stripe_cost_confirmed', 'false') = 'true' as ok;
select 'the variance alert and fee tolerance are set' as check, public.edition_commerce_cfg('editions.commerce.variance_alert_pence', '') ~ '^[0-9]+$' and public.edition_commerce_cfg('editions.commerce.fee_tolerance_pence', '') ~ '^[0-9]+$' as ok;
select 'nothing can be added to the customer total: no fee_payer other than organiser is stored' as check, count(*) = 0 as ok from public.admin_config where key = 'editions.commerce.fee_payer' and value <> 'organiser';
select 'the fee function never returns a payer other than organiser' as check, (select count(*) from public.edition_charge_breakdown('participation', 1000, 'none', gen_random_uuid()) where fee_payer = 'organiser' and charge_pence = price_pence) = 1 as ok;
select 'OneShetland is not VAT registered (platform.vat_registered false) and nothing charges VAT on commission' as check, public.edition_commerce_cfg('platform.vat_registered', 'false') = 'false' as ok;
select 'the ledger has the fee-model columns' as check, count(*) = 9 as ok from information_schema.columns where table_schema = 'public' and table_name = 'edition_payments'
  and column_name in ('commission_pence', 'recovery_estimate_pence', 'commission_refunded_pence', 'application_fee_actual_pence', 'recovery_variance_pence', 'stripe_fee_refunded_pence', 'dispute_state', 'dispute_lost_pence', 'dispute_recovered_pence');
select 'every ledger row has its commission recorded (backfilled from the old single fee)' as check, count(*) = 0 as ok from public.edition_payments where commission_pence is null;
select 'Stripe never returns its fee: stripe_fee_refunded_pence is 0 everywhere' as check, count(*) = 0 as ok from public.edition_payments where stripe_fee_refunded_pence <> 0;
select 'VAT-readiness columns exist on package orders (nullable, nothing reads them for charging)' as check, count(*) = 7 as ok from information_schema.columns where table_schema = 'public' and table_name = 'edition_orders' and is_nullable = 'YES'
  and column_name in ('net_pence', 'vat_pence', 'vat_rate_percent', 'buyer_vat_number', 'billing_name', 'billing_address', 'vat_note');
select 'the override recovery_waived flag exists' as check, count(*) = 1 as ok from information_schema.columns where table_schema = 'public' and table_name = 'edition_commercial_overrides' and column_name = 'recovery_waived';
select 'the dispute recovery queue has RLS, no FOR ALL policy and no direct write for people' as check,
  (select relrowsecurity from pg_class where oid = 'public.edition_dispute_recoveries'::regclass)
  and (select count(*) from pg_policies where tablename = 'edition_dispute_recoveries' and cmd = 'ALL') = 0
  and (select count(*) from information_schema.role_table_grants where table_name = 'edition_dispute_recoveries' and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT') = 0
  and (select count(*) from information_schema.role_table_grants where table_name = 'edition_dispute_recoveries' and grantee = 'anon') = 0 as ok;
select 'the new money-in and worker functions are not executable by people or the public' as check, count(*) = 0 as ok from pg_proc p where p.pronamespace = 'public'::regnamespace
  and p.proname in ('edition_dispute_event', 'edition_dispute_recoveries_next', 'edition_dispute_recovery_mark', 'edition_dispute_commission_next', 'edition_dispute_commission_mark', 'edition_commission_plan_pending',
    'edition_commission_refunds_next', 'edition_commission_refund_mark', 'edition_payment_note_stripe_fee', 'edition_payment_note_app_fee', 'edition_participation_payment_succeeded', 'edition_membership_payment_succeeded', 'edition_reconcile_apply', 'edition_fee_parts', 'edition_fee_calc')
  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
select 'anon cannot execute any new fee-model function' as check, count(*) = 0 as ok from pg_proc p where p.pronamespace = 'public'::regnamespace
  and (p.proname like 'edition_dispute%' or p.proname like 'edition_commission%' or p.proname like 'edition_payment_note%' or p.proname like 'admin_edition_variance%' or p.proname in ('admin_edition_fee_model_notes', 'admin_retry_edition_dispute_recovery', 'edition_fee_parts', 'edition_refund_request_before', 'edition_payments_parts_default'))
  and has_function_privilege('anon', p.oid, 'execute');
select 'the new fee-model definer functions pin search_path' as check, count(*) = 0 as ok from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
  and (p.proname like 'edition_dispute%' or p.proname like 'edition_commission%' or p.proname like 'edition_payment_note%' or p.proname like 'admin_edition_variance%' or p.proname = 'edition_fee_parts')
  and (p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'));
select 'reconciliation understands the new exception kinds' as check, (select pg_get_constraintdef(oid) from pg_constraint where conname = 'edition_recon_kind_check') ~ 'fee_variance' and (select pg_get_constraintdef(oid) from pg_constraint where conname = 'edition_recon_kind_check') ~ 'dispute_recovery_failed' as ok;
select 'no collection is suspended by a dispute recovery on a fresh database' as check, count(*) = 0 as ok from public.edition_dispute_recoveries where blocked;
select 'edition_commission_rates() is signed-in only (not anon or public), pins search_path and returns exactly the two standard rate rows' as check,
  not has_function_privilege('anon', 'public.edition_commission_rates()', 'execute') and has_function_privilege('authenticated', 'public.edition_commission_rates()', 'execute')
  and (select p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%') from pg_proc p where p.oid = 'public.edition_commission_rates()'::regprocedure) as ok;
