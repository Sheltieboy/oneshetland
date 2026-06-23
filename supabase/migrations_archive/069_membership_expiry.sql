-- 069_membership_expiry.sql
-- Make membership validity expiry-aware.
--
-- A paid membership row keeps status='active' even after paid_until passes (we
-- don't run a job to flip it), so "is this person a current member?" must also
-- check the expiry. Free memberships and admins have paid_until = NULL and are
-- therefore always valid while active. This closes the gap where a lapsed paid
-- member would still see members-only notices.

create or replace function public.is_hub_member(p_hub uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.hub_members
    where hub_id = p_hub and user_id = p_user and status = 'active'
      and (paid_until is null or paid_until > now())
  );
$$;

-- is_hub_admin is intentionally NOT expiry-gated: owner/committee run the hub and
-- don't hold paid memberships, so they must never be locked out by an expiry.

create index if not exists idx_hub_members_paid_until
  on public.hub_members (paid_until) where paid_until is not null;
