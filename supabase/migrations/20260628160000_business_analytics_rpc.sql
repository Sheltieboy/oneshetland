-- ============================================================================
-- Seller analytics RPC (Phase 1c) — aggregated, business-scoped, privacy-safe.
--
-- Returns ONLY counts/sums/timeseries scoped to one business. NEVER exposes an
-- individual user's identity or behaviour. Ownership-gated: caller must own the
-- business (or be admin). `basic` is the free teaser; `full` requires the £10
-- `analytics` add-on (business_has_analytics) — admins always get full for QA.
-- Revenue figures come from the ledgers (source of truth).
-- ============================================================================

create or replace function public.business_analytics(p_business_id uuid, p_days int default 30)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_from   timestamptz := now() - (p_days || ' days')::interval;
  v_owner  uuid;
  v_admin  boolean := public.is_admin();
  v_has    boolean;
  result   jsonb;
begin
  select owner_id into v_owner from public.local_businesses where id = p_business_id;
  if v_owner is null then raise exception 'no such business'; end if;
  if v_owner <> auth.uid() and not v_admin then raise exception 'forbidden'; end if;

  v_has := public.business_has_analytics(p_business_id);

  -- ── Free teaser (always available to the owner) ──────────────────────────
  result := jsonb_build_object(
    'business_id', p_business_id,
    'range_days',  p_days,
    'has_addon',   v_has,
    'is_admin_view', v_admin and v_owner <> auth.uid(),
    'basic', jsonb_build_object(
      'profile_views', (select count(*) from public.analytics_events
        where business_id = p_business_id and event_name = 'content_viewed' and occurred_at >= v_from),
      'unique_viewers', (select count(distinct coalesce(user_id::text, anon_id)) from public.analytics_events
        where business_id = p_business_id and event_name = 'content_viewed' and occurred_at >= v_from),
      'followers', (select count(*) from public.local_business_follows where business_id = p_business_id),
      'contacts', (select count(*) from public.analytics_events
        where business_id = p_business_id and event_name = 'contact_clicked' and occurred_at >= v_from)
    )
  );

  -- ── Full analytics (gated on the £10 add-on; admins always see it) ───────
  if v_has or v_admin then
    result := result || jsonb_build_object('full', jsonb_build_object(
      'views_by_day', (
        select coalesce(jsonb_agg(to_jsonb(t) order by t.day), '[]'::jsonb) from (
          select date_trunc('day', occurred_at)::date as day, count(*) as views
          from public.analytics_events
          where business_id = p_business_id and event_name = 'content_viewed' and occurred_at >= v_from
          group by 1
        ) t),
      'contacts_by_method', (
        select coalesce(jsonb_agg(to_jsonb(t) order by t.count desc), '[]'::jsonb) from (
          select coalesce(props->>'method','other') as method, count(*) as count
          from public.analytics_events
          where business_id = p_business_id and event_name = 'contact_clicked' and occurred_at >= v_from
          group by 1
        ) t),
      'saves', (select count(*) from public.analytics_events
        where business_id = p_business_id and event_name = 'item_saved' and occurred_at >= v_from),
      'busiest_dow', (
        select coalesce(jsonb_agg(to_jsonb(t) order by t.dow), '[]'::jsonb) from (
          select extract(dow from occurred_at)::int as dow, count(*) as views
          from public.analytics_events
          where business_id = p_business_id and event_name = 'content_viewed' and occurred_at >= v_from
          group by 1
        ) t),
      'bookings',            (select count(*) from public.book_bookings
        where business_id = p_business_id and created_at >= v_from and status <> 'cancelled'),
      'booking_revenue_pence', (select coalesce(sum(deposit_pence) filter (where deposit_paid_at is not null),0)
        from public.book_bookings where business_id = p_business_id and created_at >= v_from),
      'unit_sales',          (select count(*) from public.book_unit_purchases
        where business_id = p_business_id and created_at >= v_from),
      'unit_revenue_pence',  (select coalesce(sum(paid_amount_pence),0) from public.book_unit_purchases
        where business_id = p_business_id and created_at >= v_from),
      'tickets_sold',        (select coalesce(sum(o.tickets_count),0)
        from public.event_ticket_orders o join public.events e on e.id = o.event_id
        where e.organiser_business_id = p_business_id and o.status = 'paid' and coalesce(o.paid_at,o.created_at) >= v_from),
      'ticket_revenue_pence',(select coalesce(sum(o.total_pence),0)
        from public.event_ticket_orders o join public.events e on e.id = o.event_id
        where e.organiser_business_id = p_business_id and o.status = 'paid' and coalesce(o.paid_at,o.created_at) >= v_from),
      'loyalty_stamps',      (select count(*) from public.local_loyalty_transactions
        where business_id = p_business_id and type = 'stamp' and created_at >= v_from),
      'loyalty_rewards',     (select count(*) from public.local_loyalty_transactions
        where business_id = p_business_id and type in ('reward','redeem') and created_at >= v_from),
      'offer_redemptions',   (select count(*) from public.local_offer_redemptions r
        join public.local_offers o on o.id = r.offer_id
        where o.business_id = p_business_id and r.redeemed_at >= v_from),
      'job_applications',    (select count(*) from public.job_applications a
        join public.jobs j on j.id = a.job_id
        where j.posted_as_business_id = p_business_id and a.created_at >= v_from),
      'shift_applications',  (select count(*) from public.shift_applications a
        join public.shifts s on s.id = a.shift_id
        where s.posted_as_business_id = p_business_id and a.created_at >= v_from)
    ));
  end if;

  return result;
end $$;

revoke all on function public.business_analytics(uuid, int) from public;
grant execute on function public.business_analytics(uuid, int) to authenticated;
