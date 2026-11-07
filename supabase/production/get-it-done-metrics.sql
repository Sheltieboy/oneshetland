-- Get it done: basic activity metrics from existing data only (read-only; no schema change).
-- Excludes DEMO/TEST briefs by title. Run: supabase db query --linked -f supabase/production/get-it-done-metrics.sql
with b as (select * from public.trade_briefs where title !~* '^(demo|test|zz)'),
     m as (select m.* from public.trade_brief_matches m join b on b.id = m.brief_id)
select
  (select count(*) from b)                                                         as jobs_submitted,
  (select count(*) from b where created_at > now() - interval '30 days')            as jobs_last_30_days,
  (select count(distinct brief_id) from m)                                          as jobs_with_a_match,
  (select count(*) from m)                                                          as matches_created,
  (select count(*) from m where viewed_at is not null or status <> 'sent')          as leads_seen,
  (select count(*) from m where status = 'interested')                              as trades_interested,
  (select count(*) from m where status = 'declined')                                as trades_declined,
  (select count(*) from m where contact_shared_at is not null)                      as details_shared_by_residents,
  (select round(avg(extract(epoch from (responded_at - created_at)) / 3600)::numeric, 1) from m where responded_at is not null) as avg_hours_to_reply,
  (select count(*) from b where outcome = 'via_oneshetland')                        as outcome_sorted_via_oneshetland,
  (select count(*) from b where outcome = 'elsewhere')                              as outcome_sorted_elsewhere,
  (select count(*) from b where outcome in ('gave_up', 'no_longer_needed'))         as outcome_gave_up_or_not_needed,
  (select count(*) from public.local_businesses where cardinality(coalesce(trade_categories, '{}')) > 0 and is_active) as trades_joined,
  (select count(*) from public.local_businesses where cardinality(coalesce(trade_categories, '{}')) > 0 and is_active and trade_availability in ('now', 'weeks', 'months', 'emergency') and trade_availability_set_at > now() - interval '45 days') as trades_currently_available;
