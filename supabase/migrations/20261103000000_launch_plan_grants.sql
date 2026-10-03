-- Launch-partner plan grants — the smallest safe way to put a REAL business on Pro or Premium without charging it.
--
-- THE PROBLEM
--
-- Offers need Pro; products and passes need Premium; switching bookings on needs Pro. Every real listing is Free.
-- The only "grant" tool, business_discount_grants ("Grant discount" in the app's claims screen), is not an
-- entitlement path: it writes a row nothing reads (0 rows ever, no Stripe coupon, no reader). And plan columns are
-- locked against clients (tg_lock_business_columns), so nobody can set a plan from an admin screen. The only way left
-- was editing raw subscription columns by hand, with nothing on record.
--
-- THE MODEL — nothing new
--
-- Entitlement is already `subscription_tier` + `subscription_until > now()` (business_meets_tier, used by the
-- public read policies, the publish triggers and the owner's screens alike). A grant is therefore just those two
-- columns written through ONE audited, admin-only function, with no Stripe customer, subscription or payment.
--
--   • expiry is mandatory and bounded (1 day .. 24 months) — a grant cannot be open-ended, and it lapses by itself:
--     past `subscription_until` the business simply stops meeting the tier, with no job and nothing to revert.
--   • it REFUSES a business that has a Stripe subscription (never overwrites a paying customer) and a business that
--     already holds a live plan this function did not give it (a paid boost, a seeded plan).
--   • a later genuine subscription supersedes it with no help from us: apply_subscription_state writes the tier,
--     the period end and the subscription id, exactly as it does for any business. The grant row then reports
--     'replaced_by_subscription' and revoking it can no longer touch the paid plan.
--   • every grant and revocation is a row: business, tier, start, expiry, reason, who, when, revoked_at.
--
-- Nothing here touches Stripe, wallet or any financial table.

begin;

-- ── The audit table ─────────────────────────────────────────────────────────
create table if not exists public.launch_plan_grants (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.local_businesses(id) on delete restrict,
  tier             text not null check (tier in ('pro', 'premium')),
  starts_at        timestamptz not null default now(),
  expires_at       timestamptz not null,
  reason           text not null check (char_length(btrim(reason)) >= 10),
  granted_by       uuid references public.profiles(id) on delete set null,
  granted_via      text not null check (granted_via in ('admin', 'service_role', 'direct_sql')),
  granted_by_label text,
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz,
  revoked_by       uuid references public.profiles(id) on delete set null,
  revoked_by_label text,
  revoke_reason    text,
  superseded_at    timestamptz,
  constraint launch_plan_grants_window check (expires_at > starts_at),
  constraint launch_plan_grants_revoke_pair check ((revoked_at is null) = (revoke_reason is null))
);

comment on table public.launch_plan_grants is
  'Audit trail of manual launch-partner plan grants. Written only by admin_grant_launch_plan / admin_revoke_launch_plan. A grant is subscription_tier + subscription_until on local_businesses; this table is the record of why.';

-- At most one OPEN grant per business: granting again supersedes the previous row rather than stacking.
create unique index if not exists uq_launch_plan_grants_one_open
  on public.launch_plan_grants (business_id)
  where revoked_at is null and superseded_at is null;

alter table public.launch_plan_grants enable row level security;
revoke all on public.launch_plan_grants from anon, authenticated;
grant select on public.launch_plan_grants to authenticated;
grant all on public.launch_plan_grants to service_role;

drop policy if exists "Admins read launch plan grants" on public.launch_plan_grants;
create policy "Admins read launch plan grants" on public.launch_plan_grants
  for select to authenticated using (public.is_admin());

-- The owner can see their own grant, so their Plan screen can say honestly what it is.
drop policy if exists "Owners read their launch plan grants" on public.launch_plan_grants;
create policy "Owners read their launch plan grants" on public.launch_plan_grants
  for select to authenticated using (public.is_business_owner(business_id, auth.uid()));

-- ── Who may operate it ──────────────────────────────────────────────────────
-- Returns how the caller is authorised, or null. Fails CLOSED, including for a missing uid: a NULL auth.uid() is
-- never "trusted" on its own — only the service role, or a direct database session with no request role at all.
create or replace function public.launch_plan_authorised()
returns text
language plpgsql stable security definer set search_path = public
as $$
declare v_role text := coalesce(nullif(current_setting('role', true), ''), 'none');
begin
  if auth.uid() is not null then
    return case when public.is_admin() then 'admin' end;
  end if;
  if v_role = 'service_role' then return 'service_role'; end if;
  if v_role = 'none' then return 'direct_sql'; end if;   -- psql / the SQL editor: already past every API door
  return null;                                             -- anon, authenticated without a uid, anything else
end;
$$;

revoke execute on function public.launch_plan_authorised() from public, anon;
grant  execute on function public.launch_plan_authorised() to authenticated, service_role;

-- ── Grant ───────────────────────────────────────────────────────────────────
create or replace function public.admin_grant_launch_plan(
  p_business_id uuid,
  p_tier        text,
  p_expires_at  timestamptz,
  p_reason      text,
  p_operator    text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_via      text := public.launch_plan_authorised();
  v_uid      uuid := auth.uid();
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_operator text := nullif(btrim(coalesce(p_operator, '')), '');
  b          public.local_businesses%rowtype;
  g          public.launch_plan_grants%rowtype;
  v_new      uuid;
begin
  if v_via is null then
    raise exception 'Only an administrator can grant a launch plan' using errcode = '42501';
  end if;
  if p_business_id is null then
    raise exception 'A business is required' using errcode = '22023';
  end if;
  if p_tier is null or p_tier not in ('pro', 'premium') then
    raise exception 'Tier must be pro or premium, not %', coalesce(p_tier, '(null)') using errcode = '22023';
  end if;
  if p_expires_at is null then
    raise exception 'An expiry date is required: a launch grant is never open-ended' using errcode = '22023';
  end if;
  if p_expires_at < now() + interval '1 day' then
    raise exception 'The expiry must be at least a day in the future (got %)', p_expires_at using errcode = '22023';
  end if;
  if p_expires_at > now() + interval '24 months' then
    raise exception 'The expiry is more than 24 months away (got %). A launch grant is a trial, not a plan.', p_expires_at
      using errcode = '22023';
  end if;
  if v_reason is null or char_length(v_reason) < 10 then
    raise exception 'A reason of at least 10 characters is required' using errcode = '22023';
  end if;
  if v_uid is null and (v_operator is null or char_length(v_operator) < 3) then
    raise exception 'Say who is granting this (p_operator) when running outside an admin session' using errcode = '22023';
  end if;

  select * into b from public.local_businesses where id = p_business_id for update;
  if not found then
    raise exception 'No such business: %', p_business_id using errcode = 'P0002';
  end if;

  -- Never overwrite a paying customer. The subscription id is the genuine-subscription signal.
  if b.stripe_subscription_id is not null then
    raise exception '% already has a genuine subscription; a launch grant would overwrite it', b.name
      using errcode = '55000';
  end if;

  select * into g from public.launch_plan_grants
   where business_id = p_business_id and revoked_at is null and superseded_at is null
   for update;

  -- A live plan we did not give (a paid boost, a seeded plan) is not ours to replace.
  if not found
     and coalesce(b.subscription_tier, 'free') <> 'free'
     and b.subscription_until is not null and b.subscription_until > now() then
    raise exception '% already holds a live % plan that was not a launch grant', b.name, b.subscription_tier
      using errcode = '55000';
  end if;

  -- Idempotent: the same grant again changes nothing and records nothing.
  if found and g.tier = p_tier and g.expires_at = p_expires_at
     and b.subscription_tier = p_tier and b.subscription_until = p_expires_at then
    return jsonb_build_object('applied', false, 'reason', 'unchanged', 'grant_id', g.id,
                              'business_id', b.id, 'tier', p_tier, 'expires_at', p_expires_at);
  end if;

  if found then
    update public.launch_plan_grants set superseded_at = now() where id = g.id;
  end if;

  insert into public.launch_plan_grants
    (business_id, tier, starts_at, expires_at, reason, granted_by, granted_via, granted_by_label)
  values
    (p_business_id, p_tier, now(), p_expires_at, v_reason, v_uid, v_via, coalesce(v_operator, 'admin:' || v_uid::text))
  returning id into v_new;

  update public.local_businesses set
    subscription_tier                 = p_tier,
    subscription_until                = p_expires_at,
    subscription_cancel_at_period_end = false
  where id = p_business_id;

  return jsonb_build_object('applied', true, 'reason', case when g.id is null then 'granted' else 'replaced_previous_grant' end,
                            'grant_id', v_new, 'business_id', b.id, 'business', b.name,
                            'tier', p_tier, 'expires_at', p_expires_at);
end;
$$;

-- ── Revoke ──────────────────────────────────────────────────────────────────
create or replace function public.admin_revoke_launch_plan(
  p_business_id uuid,
  p_reason      text,
  p_operator    text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_via      text := public.launch_plan_authorised();
  v_uid      uuid := auth.uid();
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_operator text := nullif(btrim(coalesce(p_operator, '')), '');
  b          public.local_businesses%rowtype;
  g          public.launch_plan_grants%rowtype;
  v_reset    boolean := false;
begin
  if v_via is null then
    raise exception 'Only an administrator can revoke a launch plan' using errcode = '42501';
  end if;
  if p_business_id is null then
    raise exception 'A business is required' using errcode = '22023';
  end if;
  if v_reason is null or char_length(v_reason) < 5 then
    raise exception 'A reason of at least 5 characters is required' using errcode = '22023';
  end if;
  if v_uid is null and (v_operator is null or char_length(v_operator) < 3) then
    raise exception 'Say who is revoking this (p_operator) when running outside an admin session' using errcode = '22023';
  end if;

  select * into b from public.local_businesses where id = p_business_id for update;
  if not found then
    raise exception 'No such business: %', p_business_id using errcode = 'P0002';
  end if;

  select * into g from public.launch_plan_grants
   where business_id = p_business_id and revoked_at is null and superseded_at is null
   for update;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'no_open_grant', 'business_id', p_business_id);
  end if;

  -- A genuine subscription has taken over: close the grant's record, and leave the paid plan alone.
  if b.stripe_subscription_id is not null then
    update public.launch_plan_grants set superseded_at = now() where id = g.id;
    return jsonb_build_object('applied', false, 'reason', 'replaced_by_subscription',
                              'grant_id', g.id, 'business_id', p_business_id);
  end if;

  -- Only take the plan back if it is still the one this grant gave.
  if b.subscription_tier = g.tier then
    update public.local_businesses set
      subscription_tier                 = 'free',
      subscription_until                = null,
      subscription_cancel_at_period_end = false
    where id = p_business_id;
    v_reset := true;
  end if;

  update public.launch_plan_grants set
    revoked_at       = now(),
    revoked_by       = v_uid,
    revoked_by_label = coalesce(v_operator, 'admin:' || v_uid::text),
    revoke_reason    = v_reason
  where id = g.id;

  return jsonb_build_object('applied', true, 'reason', case when v_reset then 'revoked' else 'revoked_plan_left_unchanged' end,
                            'grant_id', g.id, 'business_id', p_business_id);
end;
$$;

-- ── Read back ───────────────────────────────────────────────────────────────
-- status: active | expired | revoked | superseded | replaced_by_subscription
create or replace function public.admin_list_launch_plans()
returns table (
  grant_id uuid, business_id uuid, business text, tier text, status text,
  starts_at timestamptz, expires_at timestamptz, reason text, granted_by_label text,
  created_at timestamptz, revoked_at timestamptz, revoke_reason text
)
language plpgsql stable security definer set search_path = public
as $$
begin
  if public.launch_plan_authorised() is null then
    raise exception 'Only an administrator can list launch plans' using errcode = '42501';
  end if;
  return query
    select g.id, g.business_id, b.name, g.tier,
           case when g.revoked_at is not null then 'revoked'
                when g.superseded_at is not null then 'superseded'
                when b.stripe_subscription_id is not null then 'replaced_by_subscription'
                when g.expires_at <= now() then 'expired'
                else 'active' end,
           g.starts_at, g.expires_at, g.reason, g.granted_by_label, g.created_at, g.revoked_at, g.revoke_reason
      from public.launch_plan_grants g
      join public.local_businesses b on b.id = g.business_id
     order by g.created_at desc;
end;
$$;

revoke execute on function public.admin_grant_launch_plan(uuid, text, timestamptz, text, text) from public, anon;
revoke execute on function public.admin_revoke_launch_plan(uuid, text, text)                    from public, anon;
revoke execute on function public.admin_list_launch_plans()                                     from public, anon;
grant  execute on function public.admin_grant_launch_plan(uuid, text, timestamptz, text, text) to authenticated, service_role;
grant  execute on function public.admin_revoke_launch_plan(uuid, text, text)                    to authenticated, service_role;
grant  execute on function public.admin_list_launch_plans()                                     to authenticated, service_role;

-- ── The dead "Grant discount" action ────────────────────────────────────────
-- business_discount_grants has no reader and no Stripe coupon behind it: granting one changes nothing, while the
-- app's admin screen says "Discount granted". Until it is a real feature, refuse the write with a message that
-- points at the real tool (this also covers the build already in review, which cannot be edited).
create or replace function public.tg_discount_grants_not_live()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Discount grants are not active: they do not change a business''s plan. To give a launch partner a plan, use admin_grant_launch_plan.'
    using errcode = '0A000';
end;
$$;

drop trigger if exists tg_discount_grants_not_live on public.business_discount_grants;
create trigger tg_discount_grants_not_live
  before insert on public.business_discount_grants
  for each row execute function public.tg_discount_grants_not_live();

commit;
