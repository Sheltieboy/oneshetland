-- Find a business for the launch-partner admin screen.
--
-- The admin screen needs to identify a business before granting it a plan, and show what it holds today. An admin's
-- own session cannot read an inactive listing (the public read policy hides it) and cannot read whether a Stripe
-- subscription exists (that column is locked), so the screen asks here instead. Read-only, admin-only, same
-- authorisation as the grant itself (launch_plan_authorised: an admin, the service role, or a direct session).
--
-- It returns FACTS, never the decision: whether a grant is allowed is decided by admin_grant_launch_plan, which
-- re-checks everything. No Stripe identifier is returned — only whether a subscription exists.

begin;

create or replace function public.admin_launch_business_lookup(p_query text)
returns table (
  business_id       uuid,
  name              text,
  category          text,
  address           text,
  is_active         boolean,
  is_claimed        boolean,
  tier              text,
  plan_until        timestamptz,
  plan_live         boolean,
  has_subscription  boolean,
  grant_id          uuid,
  grant_tier        text,
  grant_expires_at  timestamptz
)
language plpgsql stable security definer set search_path = public
as $$
declare
  q       text := nullif(btrim(coalesce(p_query, '')), '');
  v_by_id boolean;
begin
  if public.launch_plan_authorised() is null then
    raise exception 'Only an administrator can look up businesses for launch plans' using errcode = '42501';
  end if;
  if q is null or char_length(q) < 3 then
    raise exception 'Type at least 3 letters of the name, or paste a business id' using errcode = '22023';
  end if;

  v_by_id := q ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  return query
    select b.id, b.name, b.category, b.address, coalesce(b.is_active, false), coalesce(b.is_claimed, false),
           b.subscription_tier, b.subscription_until,
           public.business_meets_tier(b.id, 'pro'),
           (b.stripe_subscription_id is not null),
           g.id, g.tier, g.expires_at
      from public.local_businesses b
      left join lateral (
        select x.id, x.tier, x.expires_at
          from public.launch_plan_grants x
         where x.business_id = b.id and x.revoked_at is null and x.superseded_at is null and x.expires_at > now()
         order by x.created_at desc limit 1
      ) g on true
     where case when v_by_id then b.id = q::uuid
                else b.name ilike '%' || regexp_replace(q, '([\\%_])', '\\\1', 'g') || '%' end
     order by b.is_active desc, b.name
     limit 15;
end;
$$;

revoke execute on function public.admin_launch_business_lookup(text) from public, anon;
grant  execute on function public.admin_launch_business_lookup(text) to authenticated, service_role;

commit;
