-- What a boost refund would do, before anyone clicks it.
--
-- The admin screen has to tell the truth about consequences: "Pro will end now",
-- "Pro will fall back to 2 September", "no plan change". Working that out in the
-- browser would mean a second implementation of the replay rule, and two
-- implementations drift. This is the same precedence the write path uses,
-- read-only, so the sentence on the screen and the thing that happens cannot
-- disagree.
--
-- Read-only and admin-gated. It exposes nothing an admin cannot already read
-- from the purchase and the business, and it writes nothing.

begin;

create or replace function public.boost_refund_consequence(p_purchase uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  p       public.local_boost_purchases%rowtype;
  b       public.local_businesses%rowtype;
  r       record;
  v_ceil  timestamptz := null;
  v_run   timestamptz := null;
begin
  if not public.is_admin() then
    raise exception 'boost_refund_consequence: admin only' using errcode = '42501';
  end if;

  select * into p from public.local_boost_purchases where id = p_purchase;
  if not found then return jsonb_build_object('outcome', 'unknown'); end if;

  select * into b from public.local_businesses where id = p.business_id;
  if not found then return jsonb_build_object('outcome', 'unknown'); end if;

  if b.stripe_subscription_id is not null then
    return jsonb_build_object('outcome', 'subscription');
  end if;
  if b.subscription_until is null then
    return jsonb_build_object('outcome', 'no_change');
  end if;

  for r in
    select * from public.local_boost_purchases
     where business_id = p.business_id and status = 'succeeded'
     order by created_at, id
  loop
    v_ceil := greatest(r.created_at, coalesce(v_ceil, r.created_at)) + (r.weeks * interval '7 days');
  end loop;
  if v_ceil is null or b.subscription_until > v_ceil then
    return jsonb_build_object('outcome', 'not_boost_derived');
  end if;

  -- The surviving set if THIS purchase were fully refunded.
  for r in
    select * from public.local_boost_purchases
     where business_id = p.business_id
       and status = 'succeeded'
       and refund_state <> 'full'
       and id <> p_purchase
     order by created_at, id
  loop
    v_run := greatest(r.created_at, coalesce(v_run, r.created_at)) + (r.weeks * interval '7 days');
  end loop;

  if b.subscription_until is not distinct from v_run
     or (v_run is not null and v_run > b.subscription_until) then
    return jsonb_build_object('outcome', 'no_change');
  end if;
  if v_run is null or v_run <= now() then
    return jsonb_build_object('outcome', 'ends_now');
  end if;
  return jsonb_build_object('outcome', 'falls_back', 'pro_until', v_run);
end;
$function$;

revoke execute on function public.boost_refund_consequence(uuid) from anon, public;
grant  execute on function public.boost_refund_consequence(uuid) to authenticated, service_role;

commit;
