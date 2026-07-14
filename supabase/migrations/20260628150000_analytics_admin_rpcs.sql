-- ============================================================================
-- Analytics: admin aggregate RPCs (internal dashboard data layer)
--
-- All SECURITY DEFINER with an internal is_admin() gate. These are the ONLY
-- sanctioned way to read the analytics stream in aggregate. Revenue figures
-- come from the LEDGERS (source of truth), not analytics events.
-- ============================================================================

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and (role = 'admin' or is_platform_owner = true)
  );
$$;

-- ── Behavioural overview (events, conversions, funnels) ─────────────────────
create or replace function public.analytics_overview(p_days int default 30)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_from timestamptz := now() - (p_days || ' days')::interval;
  result jsonb;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;

  select jsonb_build_object(
    'range_days', p_days,
    'generated_at', now(),
    'totals', (
      select jsonb_build_object(
        'events',          count(*),
        'conversions',     count(*) filter (where is_conversion),
        'signups',         count(*) filter (where event_name = 'sign_up_completed'),
        'unique_users',    count(distinct user_id),
        'unique_visitors', count(distinct anon_id)
      ) from public.analytics_events where occurred_at >= v_from
    ),
    'by_category', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.events desc), '[]'::jsonb) from (
        select category,
               count(*) as events,
               count(*) filter (where is_conversion) as conversions
        from public.analytics_events
        where occurred_at >= v_from and category is not null
        group by category
      ) t
    ),
    'by_day', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.day), '[]'::jsonb) from (
        select date_trunc('day', occurred_at)::date as day,
               count(*) as events,
               count(*) filter (where is_conversion) as conversions
        from public.analytics_events
        where occurred_at >= v_from
        group by 1
      ) t
    ),
    'top_events', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.count desc), '[]'::jsonb) from (
        select event_name, count(*) as count, bool_or(is_conversion) as is_conversion
        from public.analytics_events
        where occurred_at >= v_from
        group by event_name
        order by count(*) desc
        limit 25
      ) t
    ),
    'top_content', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.count desc), '[]'::jsonb) from (
        select object_type, count(*) as count, count(distinct object_id) as distinct_items
        from public.analytics_events
        where occurred_at >= v_from and event_name = 'content_viewed' and object_type is not null
        group by object_type
      ) t
    )
  ) into result;

  return result;
end $$;

-- ── Revenue rollup (from the LEDGERS — source of truth) ──────────────────────
create or replace function public.analytics_revenue(p_days int default 30)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_from timestamptz := now() - (p_days || ' days')::interval;
  result jsonb;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;

  select jsonb_build_object(
    'range_days', p_days,
    'streams', jsonb_build_array(
      (select jsonb_build_object('stream','Event tickets','orders',count(*),
         'gross_pence',coalesce(sum(total_pence),0),'fees_pence',coalesce(sum(platform_fee_pence),0))
        from public.event_ticket_orders where status='paid' and coalesce(paid_at,created_at) >= v_from),
      (select jsonb_build_object('stream','Passes & units','orders',count(*),
         'gross_pence',coalesce(sum(paid_amount_pence),0),'fees_pence',0)
        from public.book_unit_purchases where created_at >= v_from),
      (select jsonb_build_object('stream','Booking deposits','orders',count(*) filter (where deposit_paid_at is not null),
         'gross_pence',coalesce(sum(deposit_pence) filter (where deposit_paid_at is not null),0),'fees_pence',0)
        from public.book_bookings where created_at >= v_from),
      (select jsonb_build_object('stream','Gifts','orders',count(*),
         'gross_pence',coalesce(sum(price_paid_pence),0),'fees_pence',0)
        from public.book_gifts where status in ('sent','claimed','used') and created_at >= v_from),
      (select jsonb_build_object('stream','Hub donations','orders',count(*),
         'gross_pence',coalesce(sum(amount_pence),0),'fees_pence',coalesce(sum(fee_pence),0))
        from public.hub_donations where created_at >= v_from),
      (select jsonb_build_object('stream','Hub memberships','orders',count(*) filter (where coalesce(last_payment_pence,0)>0),
         'gross_pence',coalesce(sum(last_payment_pence),0),'fees_pence',0)
        from public.hub_members where joined_at >= v_from),
      (select jsonb_build_object('stream','Wallet top-ups (float)','orders',count(*),
         'gross_pence',coalesce(sum(amount_pence),0),'fees_pence',0)
        from public.local_wallet_transactions where type='topup' and created_at >= v_from),
      (select jsonb_build_object('stream','Wallet payments','orders',count(*),
         'gross_pence',coalesce(sum(abs(amount_pence)),0),'fees_pence',coalesce(sum(platform_fee_pence),0))
        from public.local_wallet_transactions where type='spend' and created_at >= v_from),
      (select jsonb_build_object('stream','Delivery','orders',count(*),
         'gross_pence',coalesce(sum(total_fee_pence),0),'fees_pence',0)
        from public.delivery_requests where payment_status='captured' and created_at >= v_from),
      (select jsonb_build_object('stream','Business boosts','orders',count(*),
         'gross_pence',coalesce(sum(amount_pence),0),'fees_pence',0)
        from public.local_boost_purchases where status='succeeded' and created_at >= v_from)
    )
  ) into result;

  return result;
end $$;

-- ── Top searches (demand signal — incl. zero-result gaps) ────────────────────
create or replace function public.analytics_top_searches(p_days int default 30, p_limit int default 25)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_from timestamptz := now() - (p_days || ' days')::interval;
  result jsonb;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.searches desc), '[]'::jsonb) into result from (
    select lower(props->>'query') as query,
           (props->>'section')    as section,
           count(*)               as searches,
           count(*) filter (where coalesce((props->>'results_count')::int, 1) = 0) as zero_result
    from public.analytics_events
    where event_name = 'search_performed' and occurred_at >= v_from
      and coalesce(props->>'query','') <> ''
    group by lower(props->>'query'), props->>'section'
    order by count(*) desc
    limit p_limit
  ) t;

  return result;
end $$;

revoke all on function public.analytics_overview(int)      from public;
revoke all on function public.analytics_revenue(int)       from public;
revoke all on function public.analytics_top_searches(int,int) from public;
grant execute on function public.analytics_overview(int)      to authenticated;
grant execute on function public.analytics_revenue(int)       to authenticated;
grant execute on function public.analytics_top_searches(int,int) to authenticated;
