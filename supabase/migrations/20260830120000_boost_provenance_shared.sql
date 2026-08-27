-- One provenance rule for boost refunds, and the end of a one-second bug.
--
-- THE BUG
--
-- The real £7 boost was bought at 19:41:54.174679 and granted Pro until
-- 19:41:55.51 — the checkout writes created_at, and the WEBHOOK computes the
-- expiry when it arrives, 1.335321 seconds later. Both the preview and the
-- writer decided "can the boosts account for this expiry?" by RECOMPUTING the
-- ceiling as created_at + weeks × 7 days, which lands 1.3 seconds SHORT of the
-- expiry the webhook actually wrote. subscription_until was therefore above the
-- ceiling, and both concluded the entitlement came from somewhere else.
--
-- The admin screen said "this business's plan was not set by this boost", and
-- that was not merely a display fault: the writer would have made the same
-- decision. A full refund would have returned the money and left Pro running
-- to 2 September.
--
-- The fixtures missed it because they built purchases with
-- expires_at = created_at + weeks × 7 days exactly. Real fulfilment is never
-- that punctual. A test that cannot reproduce a clock is not testing a clock.
--
-- THE FIX
--
-- Stop recomputing what was already recorded. Each purchase stores the
-- cumulative expiry it produced, so the furthest date the boosts ever granted
-- is simply the greatest expires_at among them. It is a fact, not a
-- reconstruction, and no arithmetic can drift away from it.
--
-- And make the preview and the writer share it. They were two hand-written
-- copies of the same rule, which is why they agreed here — both wrong. Now
-- there is one function and both call it.

begin;

-- ── The provenance question, asked once ─────────────────────────────────────
--
--   live_subscription    a paying subscription outranks any boost
--   nothing_to_reduce    no expiry to take away
--   not_boost_derived    the expiry is beyond anything the boosts wrote
--   ours                 the boosts account for it, so a refund may recompute it

create or replace function public.boost_entitlement_provenance(p_business uuid)
returns text
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  b      public.local_businesses%rowtype;
  v_ceil timestamptz;
begin
  select * into b from public.local_businesses where id = p_business;
  if not found then return 'no_business'; end if;
  if b.stripe_subscription_id is not null then return 'live_subscription'; end if;
  if b.subscription_until is null then return 'nothing_to_reduce'; end if;

  -- The furthest expiry the boosts actually WROTE. Recorded, never recomputed:
  -- recomputing it from created_at is what lost the 1.3 seconds.
  select max(expires_at) into v_ceil
    from public.local_boost_purchases
   where business_id = p_business and status = 'succeeded' and expires_at is not null;

  if v_ceil is null or b.subscription_until > v_ceil then return 'not_boost_derived'; end if;
  return 'ours';
end;
$function$;

comment on function public.boost_entitlement_provenance(uuid) is
  'Can a boost refund safely recompute this business''s expiry? The single authority, used by both the refund writer and the admin preview so the two cannot disagree.';

-- ── The replay, with an optional purchase treated as already gone ───────────
--
-- The writer replays AFTER marking a purchase fully refunded; the preview has
-- to ask what WOULD happen if it were. Same fold, one parameter apart, so the
-- two can never drift.

create or replace function public.boost_entitlement_excluding(p_business uuid, p_exclude uuid)
returns timestamptz
language plpgsql stable security definer set search_path to 'public'
as $function$
declare r record; v_run timestamptz := null;
begin
  for r in
    select * from public.local_boost_purchases
     where business_id = p_business
       and status = 'succeeded'
       and refund_state <> 'full'
       and (p_exclude is null or id <> p_exclude)
     order by created_at, id
  loop
    v_run := greatest(r.created_at, coalesce(v_run, r.created_at))
             + (r.weeks * interval '7 days');
  end loop;
  return v_run;
end;
$function$;

create or replace function public.boost_entitlement(p_business uuid)
returns table (entitled boolean, pro_until timestamptz, purchases_left integer)
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_until timestamptz; v_left integer;
begin
  v_until := public.boost_entitlement_excluding(p_business, null);
  select count(*)::integer into v_left from public.local_boost_purchases
   where business_id = p_business and status = 'succeeded' and refund_state <> 'full';
  return query select (v_until is not null and v_until > now()), v_until, v_left;
end;
$function$;

-- ── The writer, now asking the shared question ──────────────────────────────

create or replace function public.apply_boost_entitlement(p_business uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  b       public.local_businesses%rowtype;
  v_prov  text;
  v_until timestamptz;
  v_left  integer;
  v_tier  text;
begin
  select * into b from public.local_businesses where id = p_business for update;
  if not found then return jsonb_build_object('applied', false, 'reason', 'no_business'); end if;

  v_prov := public.boost_entitlement_provenance(p_business);
  if v_prov <> 'ours' then
    return jsonb_build_object('applied', false, 'reason', v_prov,
                              'subscription_until', b.subscription_until);
  end if;

  select pro_until, purchases_left into v_until, v_left from public.boost_entitlement(p_business);

  -- An expired boost refunded weeks later can replay to the value the business
  -- already holds. Writing it again would be a no-op that still fires the
  -- column-lock trigger and moves updated_at, so don't.
  if b.subscription_until is not distinct from v_until then
    return jsonb_build_object('applied', false, 'reason', 'no_change',
                              'subscription_until', v_until, 'purchases_left', v_left);
  end if;
  -- A refund is not a route to extending anyone's Pro access.
  if v_until is not null and v_until > b.subscription_until then
    return jsonb_build_object('applied', false, 'reason', 'would_extend',
                              'subscription_until', b.subscription_until);
  end if;

  v_tier := case when v_until is not null and v_until > now() then 'pro' else 'free' end;

  update public.local_businesses set
    subscription_tier                 = v_tier,
    subscription_until                = v_until,
    subscription_cancel_at_period_end = false
  where id = p_business;

  return jsonb_build_object('applied', true, 'tier', v_tier,
                            'subscription_until', v_until, 'purchases_left', v_left);
end;
$function$;

-- ── The preview, asking the SAME question about the SAME replay ─────────────

create or replace function public.boost_refund_consequence(p_purchase uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  p      public.local_boost_purchases%rowtype;
  b      public.local_businesses%rowtype;
  v_prov text;
  v_run  timestamptz;
begin
  if not public.is_admin() then
    raise exception 'boost_refund_consequence: admin only' using errcode = '42501';
  end if;

  select * into p from public.local_boost_purchases where id = p_purchase;
  if not found then return jsonb_build_object('outcome', 'unknown'); end if;
  select * into b from public.local_businesses where id = p.business_id;
  if not found then return jsonb_build_object('outcome', 'unknown'); end if;

  v_prov := public.boost_entitlement_provenance(p.business_id);
  if v_prov = 'live_subscription'  then return jsonb_build_object('outcome', 'subscription'); end if;
  if v_prov = 'not_boost_derived'  then return jsonb_build_object('outcome', 'not_boost_derived'); end if;
  if v_prov <> 'ours'              then return jsonb_build_object('outcome', 'no_change'); end if;

  v_run := public.boost_entitlement_excluding(p.business_id, p_purchase);

  if b.subscription_until is not distinct from v_run
     or (v_run is not null and v_run > b.subscription_until) then
    return jsonb_build_object('outcome', 'no_change');
  end if;
  if v_run is null or v_run <= now() then
    return jsonb_build_object('outcome', 'returns_to_free');
  end if;
  return jsonb_build_object('outcome', 'falls_back', 'pro_until', v_run);
end;
$function$;

revoke execute on function public.boost_entitlement_provenance(uuid)     from anon, authenticated, public;
revoke execute on function public.boost_entitlement_excluding(uuid,uuid) from anon, authenticated, public;
grant  execute on function public.boost_entitlement_provenance(uuid)     to service_role;
grant  execute on function public.boost_entitlement_excluding(uuid,uuid) to service_role;
revoke execute on function public.boost_refund_consequence(uuid) from anon, public;
grant  execute on function public.boost_refund_consequence(uuid) to authenticated, service_role;

commit;
