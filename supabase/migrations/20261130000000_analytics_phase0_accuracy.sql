-- 20261130000000_analytics_phase0_accuracy.sql  (LOCAL: not applied anywhere)
-- Owner analytics, Phase 0: make the EXISTING /admin/analytics figures accurate. Replaces the two admin RPCs (same names, same JSON keys, additive new keys) and adds
-- internal helpers. No tables, no data and no tracking are changed; analytics history is never deleted — exclusions happen only at READ time.
--
--  * analytics_internal_users()      who counts as internal/test (administrators, platform owner, 'ZZ…' test profiles, known test e-mail domains)
--  * analytics_classified_events()   every raw event in a window with a reason it is excluded from reporting (or NULL = reportable):
--        internal         user_type 'admin', an internal user, or an anonymous id that was ever used by an internal user
--        orphan_ledger    a server-recorded ledger event whose ledger row no longer exists (bursts of test/abuse activity that was later deleted)
--        duplicate        the same ledger event repeated for the same order (status toggling): only the first is kept
--  * analytics_overview(days)        reportable events only; sign-ups from auth.users (authoritative); signed-in users by user_id; anonymous visitors exclude anyone who signed in
--  * analytics_revenue(days)         sales streams with gross / refunded / net / platform revenue, wallet funds reported SEPARATELY (never added to sales), shop and shift boosts
--                                    added, subscriptions reported from plan state (estimate), internal/test purchases excluded and counted
-- Rollback: re-run 20260628150000_analytics_admin_rpcs.sql (it defines the original analytics_overview / analytics_revenue), then drop the two helper functions.

create or replace function public.analytics_internal_users() returns setof uuid
language sql stable security definer set search_path = public, auth, pg_temp as $$
  select p.id from public.profiles p
   where p.role = 'admin' or coalesce(p.is_platform_owner, false)
      or coalesce(p.display_name, '') ~* '^zz' or coalesce(p.full_name, '') ~* '^zz'
  union
  select u.id from auth.users u
   where lower(u.email) ~ '(@probe\.invalid|@testonshetland\.com|@darrenfullerton\.com|@example\.(com|org|net))$' or lower(u.email) ~ '^zz'
$$;

create or replace function public.analytics_classified_events(p_from timestamptz, p_to timestamptz)
returns table (id bigint, occurred_at timestamptz, event_name text, user_id uuid, anon_id text, session_id text, platform text, category text, is_conversion boolean,
               object_type text, object_id text, order_id uuid, reason text)
language sql stable security definer set search_path = public, auth, pg_temp as $$
  with internal as (select analytics_internal_users() as uid),
  internal_anon as (select distinct e.anon_id from public.analytics_events e where e.user_id in (select uid from internal) and e.anon_id is not null),
  base as (
    select e.id, e.occurred_at, e.event_name, e.user_id, e.anon_id, e.session_id, e.platform, e.category, e.is_conversion, e.object_type, e.object_id, e.order_id,
           coalesce(coalesce(e.user_type, '') = 'admin' or e.user_id in (select uid from internal) or e.anon_id in (select anon_id from internal_anon), false) as is_internal,
           case when e.order_id is null then true else case e.event_name
             when 'event_ticket_purchased'    then exists (select 1 from public.event_ticket_orders o   where o.id = e.order_id)
             when 'unit_purchase_completed'   then exists (select 1 from public.book_unit_purchases o   where o.id = e.order_id)
             when 'booking_confirmed'         then exists (select 1 from public.book_bookings o         where o.id = e.order_id)
             when 'booking_paid'              then exists (select 1 from public.book_bookings o         where o.id = e.order_id)
             when 'gift_purchased'            then exists (select 1 from public.book_gifts o            where o.id = e.order_id)
             when 'hub_donation_completed'    then exists (select 1 from public.hub_donations o         where o.id = e.order_id)
             when 'hub_membership_paid'       then exists (select 1 from public.hub_members o           where o.id = e.order_id)
             when 'hub_membership_joined'     then exists (select 1 from public.hub_members o           where o.id = e.order_id)
             when 'wallet_payment_completed'  then exists (select 1 from public.local_wallet_transactions o where o.id = e.order_id)
             when 'wallet_topup_completed'    then exists (select 1 from public.local_wallet_transactions o where o.id = e.order_id)
             when 'delivery_payment_captured' then exists (select 1 from public.delivery_requests o     where o.id = e.order_id)
             when 'delivery_request_created'  then exists (select 1 from public.delivery_requests o     where o.id = e.order_id)
             when 'business_boost_purchased'  then exists (select 1 from public.local_boost_purchases o where o.id = e.order_id)
             else true end end as ledger_ok
      from public.analytics_events e
     where e.occurred_at >= p_from and e.occurred_at < p_to),
  cand as (select b.id, row_number() over (partition by b.event_name, b.order_id order by b.id) as rn from base b where not b.is_internal and b.ledger_ok and b.order_id is not null)
  select b.id, b.occurred_at, b.event_name, b.user_id, b.anon_id, b.session_id, b.platform, b.category, b.is_conversion, b.object_type, b.object_id, b.order_id,
         case when b.is_internal then 'internal' when not b.ledger_ok then 'orphan_ledger' when c.rn > 1 then 'duplicate' end as reason
    from base b left join cand c on c.id = b.id
$$;

revoke all on function public.analytics_internal_users(), public.analytics_classified_events(timestamptz, timestamptz) from public, anon, authenticated;

-- ── Behavioural overview ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.analytics_overview(p_days int default 30)
returns jsonb language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare v_from timestamptz := now() - (greatest(least(coalesce(p_days, 30), 365), 1) || ' days')::interval; v_to timestamptz := now(); result jsonb;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  with ce as materialized (select * from public.analytics_classified_events(v_from, v_to)),
       ve as materialized (select * from ce where reason is null),
       signed_anon as (select distinct anon_id from ve where user_id is not null and anon_id is not null),
       reg as (select u.id, u.email_confirmed_at from auth.users u where u.created_at >= v_from and u.created_at < v_to and u.id not in (select analytics_internal_users()))
  select jsonb_build_object(
    'range_days', greatest(least(coalesce(p_days, 30), 365), 1),
    'generated_at', now(),
    'totals', (select jsonb_build_object(
        'events',                (select count(*) from ve),
        'conversions',           (select count(*) from ve where is_conversion),
        'signups',               (select count(*) from reg),
        'signups_confirmed',     (select count(*) from reg where email_confirmed_at is not null),
        'unique_users',          (select count(distinct user_id) from ve where user_id is not null),
        'unique_visitors',       (select count(distinct anon_id) from ve where user_id is null and anon_id is not null and anon_id not in (select anon_id from signed_anon)),
        'sessions',              (select count(distinct session_id) from ve where session_id is not null),
        'events_signed_in',      (select count(*) from ve where user_id is not null),
        'events_anonymous',      (select count(*) from ve where user_id is null)
      )),
    'excluded', (select jsonb_build_object(
        'raw_events', (select count(*) from ce),
        'internal_or_test', (select count(*) from ce where reason = 'internal'),
        'unmatched_ledger', (select count(*) from ce where reason = 'orphan_ledger'),
        'duplicate_ledger', (select count(*) from ce where reason = 'duplicate'))),
    'by_category', (select coalesce(jsonb_agg(to_jsonb(t) order by t.events desc), '[]'::jsonb) from (
        select category, count(*) as events, count(*) filter (where is_conversion) as conversions from ve where category is not null group by category) t),
    'by_day', (select coalesce(jsonb_agg(to_jsonb(t) order by t.day), '[]'::jsonb) from (
        select date_trunc('day', occurred_at)::date as day, count(*) as events, count(*) filter (where is_conversion) as conversions from ve group by 1) t),
    'top_events', (select coalesce(jsonb_agg(to_jsonb(t) order by t.count desc), '[]'::jsonb) from (
        select event_name, count(*) as count, bool_or(is_conversion) as is_conversion from ve group by event_name order by count(*) desc limit 25) t),
    'top_content', (select coalesce(jsonb_agg(to_jsonb(t) order by t.count desc), '[]'::jsonb) from (
        select object_type, count(*) as count, count(distinct object_id) as distinct_items from ve where event_name = 'content_viewed' and object_type is not null group by object_type) t)
  ) into result;
  return result;
end $$;

-- ── Revenue ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- gross     what customers paid through OneShetland for goods, services, tickets, donations and OneShetland's own products (before refunds). NEVER includes wallet top-ups.
-- refunded  of that, what has been refunded
-- net       gross - refunded
-- platform  what OneShetland keeps (commission / fees; 100% of boosts), net of refunds. NULL = not recorded for that stream.
create or replace function public.analytics_revenue(p_days int default 30)
returns jsonb language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare v_days int := greatest(least(coalesce(p_days, 30), 365), 1); v_from timestamptz := now() - (v_days || ' days')::interval; v_to timestamptz := now(); result jsonb;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  with internal as (select analytics_internal_users() as uid),
  src as (
    select 'Event tickets'::text as stream, 1 as ord, o.buyer_id as who, o.total_pence::bigint as gross, case when o.status = 'refunded' then o.total_pence else 0 end::bigint as refunded,
           case when o.status = 'refunded' then 0 else coalesce(o.platform_fee_pence, 0) end::bigint as platform
      from public.event_ticket_orders o where o.status in ('paid', 'refunded') and coalesce(o.paid_at, o.created_at) >= v_from and coalesce(o.paid_at, o.created_at) < v_to
    union all
    select 'Shop orders', 2, o.buyer_id, o.total_pence, case when o.refund_state = 'refunded' or o.status = 'refunded' then o.total_pence else 0 end,
           case when o.refund_state = 'refunded' or o.status = 'refunded' then 0 else coalesce(o.commission_pence, 0) end
      from public.product_orders o where o.status in ('paid', 'completed', 'refunded') and coalesce(o.paid_at, o.created_at) >= v_from and coalesce(o.paid_at, o.created_at) < v_to
    union all
    select 'Passes & units', 3, o.owner_id, o.paid_amount_pence, case when o.refund_state = 'refunded' then o.paid_amount_pence else 0 end, null
      from public.book_unit_purchases o where o.created_at >= v_from and o.created_at < v_to
    union all
    select 'Booking deposits', 4, o.customer_id, o.deposit_pence, 0, null
      from public.book_bookings o where o.deposit_paid_at is not null and o.deposit_paid_at >= v_from and o.deposit_paid_at < v_to
    union all
    select 'Gifts', 5, o.purchaser_id, o.price_paid_pence, 0, null
      from public.book_gifts o where o.status in ('sent', 'claimed', 'used') and o.created_at >= v_from and o.created_at < v_to
    union all
    select 'Hub donations', 6, o.donor_user_id, o.amount_pence, 0, coalesce(o.fee_pence, 0)
      from public.hub_donations o where o.created_at >= v_from and o.created_at < v_to
    union all
    select 'Hub memberships (latest payment)', 7, o.user_id, o.last_payment_pence, 0, null
      from public.hub_members o where coalesce(o.last_payment_pence, 0) > 0 and o.joined_at >= v_from and o.joined_at < v_to
    union all
    select 'Fetch deliveries', 8, o.customer_id, o.total_fee_pence, case when o.payment_status = 'refunded' then o.total_fee_pence else 0 end, null
      from public.delivery_requests o where o.payment_status in ('captured', 'refunded') and o.created_at >= v_from and o.created_at < v_to
    union all
    select 'Business boosts', 9, o.owner_id, o.amount_pence, coalesce(o.refunded_pence, 0), o.amount_pence - coalesce(o.refunded_pence, 0)
      from public.local_boost_purchases o where o.status in ('succeeded', 'refunded', 'partially_refunded') and o.created_at >= v_from and o.created_at < v_to
    union all
    select 'Shift boosts', 10, o.employer_id, o.amount_pence, 0, o.amount_pence
      from public.shift_boost_purchases o where o.status in ('completed', 'paid') and o.purchased_at >= v_from and o.purchased_at < v_to),
  agg as (
    select stream, ord,
           count(*) filter (where who is null or who not in (select uid from internal)) as orders,
           coalesce(sum(gross) filter (where who is null or who not in (select uid from internal)), 0) as gross,
           coalesce(sum(refunded) filter (where who is null or who not in (select uid from internal)), 0) as refunded,
           sum(platform) filter (where who is null or who not in (select uid from internal)) as platform,
           count(*) filter (where who in (select uid from internal)) as internal_orders,
           coalesce(sum(gross) filter (where who in (select uid from internal)), 0) as internal_gross
      from src group by stream, ord),
  wal as (
    select w.type, w.amount_pence, w.platform_fee_pence from public.local_wallet_transactions w
     where w.created_at >= v_from and w.created_at < v_to and (w.user_id is null or w.user_id not in (select uid from internal))),
  subs as (
    select count(*) filter (where b.stripe_subscription_id is not null and b.subscription_tier in ('pro', 'premium') and b.subscription_until > now()) as paying_total,
           count(*) filter (where b.stripe_subscription_id is not null and b.subscription_tier = 'pro' and b.subscription_until > now()) as paying_pro,
           count(*) filter (where b.stripe_subscription_id is not null and b.subscription_tier = 'premium' and b.subscription_until > now()) as paying_premium,
           count(*) filter (where b.stripe_subscription_id is null and b.subscription_tier in ('pro', 'premium') and b.subscription_until > now()) as complimentary
      from public.local_businesses b)
  select jsonb_build_object(
    'range_days', v_days,
    'streams', (select coalesce(jsonb_agg(jsonb_build_object('stream', stream, 'orders', orders, 'gross_pence', gross, 'refunded_pence', refunded, 'net_pence', gross - refunded,
                  'platform_pence', platform, 'fees_pence', coalesce(platform, 0)) order by ord), '[]'::jsonb) from agg),
    'totals', (select jsonb_build_object('orders', coalesce(sum(orders), 0), 'gross_pence', coalesce(sum(gross), 0), 'refunded_pence', coalesce(sum(refunded), 0),
                  'net_pence', coalesce(sum(gross - refunded), 0), 'platform_pence', coalesce(sum(platform), 0),
                  'excluded_internal_orders', coalesce(sum(internal_orders), 0), 'excluded_internal_gross_pence', coalesce(sum(internal_gross), 0)) from agg),
    'wallet', (select jsonb_build_object(
                  'topups_pence', coalesce(sum(amount_pence) filter (where type = 'topup'), 0), 'topups', count(*) filter (where type = 'topup'),
                  'spent_pence', coalesce(sum(abs(amount_pence)) filter (where type = 'spend'), 0), 'spends', count(*) filter (where type = 'spend'),
                  'refunded_to_wallet_pence', coalesce(sum(amount_pence) filter (where type = 'refund'), 0),
                  'adjustments_pence', coalesce(sum(amount_pence) filter (where type = 'reconciliation'), 0)) from wal),
    'subscriptions', (select jsonb_build_object('paying', paying_total, 'paying_pro', paying_pro, 'paying_premium', paying_premium, 'complimentary', complimentary,
                  'est_mrr_pence', paying_pro * 1200 + paying_premium * 2900) from subs)
  ) into result;
  return result;
end $$;

revoke all on function public.analytics_overview(int), public.analytics_revenue(int) from public, anon;
grant execute on function public.analytics_overview(int), public.analytics_revenue(int) to authenticated;
