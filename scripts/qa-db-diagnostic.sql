-- ============================================================================
-- QA C1 — Live DB vs code reconciliation diagnostic (read-only; changes nothing).
--
-- Run as ONE query. The Supabase SQL editor only shows the LAST statement's
-- grid, so this is a single SELECT that returns one row per check (check, result)
-- — everything visible at once. Paste the whole grid back.
--
-- How to read it:
--   table: <name>        true  = present
--   rpc:   <name>         a type (e.g. "jsonb") = present + its return type;
--                         "— MISSING —" = the function doesn't exist
--   column: <t>.<c>      true  = present
--   max tracked migration the schema_migrations high-water mark (known to lag)
-- ============================================================================

with checks(sort, label, result) as (
  -- ── Tables ────────────────────────────────────────────────────────────────
  select 1,  'table: jobs',                  (to_regclass('public.jobs')                  is not null)::text
  union all select 2,  'table: job_applications',     (to_regclass('public.job_applications')      is not null)::text
  union all select 3,  'table: worker_profiles',      (to_regclass('public.worker_profiles')       is not null)::text
  union all select 4,  'table: shifts',               (to_regclass('public.shifts')                is not null)::text
  union all select 5,  'table: events',               (to_regclass('public.events')                is not null)::text
  union all select 6,  'table: event_ticket_orders',  (to_regclass('public.event_ticket_orders')   is not null)::text
  union all select 7,  'table: hubs',                 (to_regclass('public.hubs')                  is not null)::text
  union all select 8,  'table: hub_campaigns',        (to_regclass('public.hub_campaigns')         is not null)::text
  union all select 9,  'table: local_wallet_balances',(to_regclass('public.local_wallet_balances') is not null)::text
  union all select 10, 'table: book_unit_items',      (to_regclass('public.book_unit_items')       is not null)::text
  union all select 11, 'table: book_gifts',           (to_regclass('public.book_gifts')            is not null)::text
  -- ── RPCs (return type shown so we can confirm shape, not just existence) ────
  union all select 20, 'rpc: get_customer_info_for_request',  coalesce((select pg_get_function_result(oid) from pg_proc where proname='get_customer_info_for_request' limit 1), '— MISSING —')
  union all select 21, 'rpc: get_driver_info_for_request',    coalesce((select pg_get_function_result(oid) from pg_proc where proname='get_driver_info_for_request'   limit 1), '— MISSING —')
  union all select 22, 'rpc: increment_event_tickets_sold',   coalesce((select pg_get_function_result(oid) from pg_proc where proname='increment_event_tickets_sold'  limit 1), '— MISSING —')
  union all select 23, 'rpc: wallet_debit',                   coalesce((select pg_get_function_result(oid) from pg_proc where proname='wallet_debit'                  limit 1), '— MISSING —')
  union all select 24, 'rpc: wallet_credit',                  coalesce((select pg_get_function_result(oid) from pg_proc where proname='wallet_credit'                 limit 1), '— MISSING —')
  union all select 25, 'rpc: record_hub_donation',            coalesce((select pg_get_function_result(oid) from pg_proc where proname='record_hub_donation'           limit 1), '— MISSING —')
  union all select 26, 'rpc: activate_hub_membership',        coalesce((select pg_get_function_result(oid) from pg_proc where proname='activate_hub_membership'       limit 1), '— MISSING —')
  union all select 27, 'rpc: reserve_ticket_slots',           coalesce((select pg_get_function_result(oid) from pg_proc where proname='reserve_ticket_slots'          limit 1), '— MISSING —')
  union all select 28, 'rpc: generate_ticket_backup_code',    coalesce((select pg_get_function_result(oid) from pg_proc where proname='generate_ticket_backup_code'   limit 1), '— MISSING —')
  union all select 29, 'rpc: generate_gift_code',             coalesce((select pg_get_function_result(oid) from pg_proc where proname='generate_gift_code'            limit 1), '— MISSING —')
  union all select 30, 'rpc: claim_gift',                     coalesce((select pg_get_function_result(oid) from pg_proc where proname='claim_gift'                    limit 1), '— MISSING —')
  -- ── Payment/payout columns the code relies on ──────────────────────────────
  union all select 40, 'column: local_businesses.payout_enabled',              (exists (select 1 from information_schema.columns where table_name='local_businesses' and column_name='payout_enabled'))::text
  union all select 41, 'column: local_businesses.has_business_payment_method',  (exists (select 1 from information_schema.columns where table_name='local_businesses' and column_name='has_business_payment_method'))::text
  union all select 42, 'column: local_businesses.business_stripe_customer_id',  (exists (select 1 from information_schema.columns where table_name='local_businesses' and column_name='business_stripe_customer_id'))::text
  union all select 43, 'column: hubs.is_charity',                              (exists (select 1 from information_schema.columns where table_name='hubs' and column_name='is_charity'))::text
  -- ── Migration tracker ──────────────────────────────────────────────────────
  union all select 99, 'max tracked migration', (select max(version)::text from supabase_migrations.schema_migrations)
)
select label as check, result from checks order by sort;
