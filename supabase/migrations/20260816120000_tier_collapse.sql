-- ============================================================================
-- Tier collapse — one axis instead of two.
--
-- Add-ons are abolished. What a business gets is decided by its subscription
-- tier alone, mirrored in code by lib/listing-tiers.ts (TIER_FEATURES).
-- Full reasoning: oneshetland-web/docs/tier-model.md.
--
-- This migration moves the one gate that lived in the DATABASE rather than the
-- application: full analytics. It was sold as a £10/month add-on; it is now
-- simply part of Pro.
--
-- The business_addons table is deliberately NOT dropped here. Dropping data is
-- irreversible and nothing reads it any more, so it is left in place to be
-- removed in a later migration once this one has been live for a while.
-- ============================================================================

-- ── Full analytics: Pro and above, instead of the analytics add-on ──────────
--
-- Kept as a function with the same name and signature so business_analytics()
-- needs no change — it still calls business_has_analytics(), which now asks a
-- different question. Admins continue to get full analytics for QA via the
-- caller's own is_admin() check.
create or replace function public.business_has_analytics(p_business_id uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.local_businesses
    where id = p_business_id
      and subscription_tier in ('pro', 'premium')
  )
$$;

comment on function public.business_has_analytics(uuid) is
  'True when the business tier includes full analytics (Pro and above). Was the £10 analytics add-on until the tier collapse, Aug 2026.';

-- ── Partner alerts: record acceptance of the usage policy ───────────────────
--
-- Alerts reach every user on the platform immediately, and urgent kinds bypass
-- quiet hours. Premium plus admin approval are two gates; this is the third.
-- An organisation must accept the usage rules before it can send its first
-- alert, so "I didn't know" is never the explanation for a misused broadcast.
alter table public.business_alert_access
  add column if not exists policy_accepted_at timestamptz,
  add column if not exists policy_accepted_by uuid references auth.users(id) on delete set null;

comment on column public.business_alert_access.policy_accepted_at is
  'When the business accepted the alerts usage policy. NULL = has never accepted; sending must be blocked.';

-- Businesses already approved before the policy existed have not accepted it,
-- so they are left NULL on purpose: they will be asked once, at next send.

-- ── Accepting the policy is what activates alerts ───────────────────────────
--
-- Replaces the old "pay £10 and a webhook flips you to active" step. Done as an
-- RPC rather than a client-side update because it moves a business from
-- 'approved' to 'active', and a client must not be able to write its own status
-- column. Re-checks all three gates server-side: ownership, prior admin
-- approval, and Premium.
create or replace function public.accept_alert_policy(p_business_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
  v_tier  text;
  v_status text;
begin
  select owner_id, subscription_tier into v_owner, v_tier
  from public.local_businesses where id = p_business_id;

  if v_owner is null then raise exception 'no such business'; end if;
  if v_owner <> auth.uid() then raise exception 'forbidden'; end if;
  if v_tier is distinct from 'premium' then
    raise exception 'alerts require a Premium plan';
  end if;

  select status into v_status
  from public.business_alert_access where business_id = p_business_id;

  if v_status is null then raise exception 'no alert access request found'; end if;
  if v_status <> 'approved' then
    raise exception 'alert access is %, not approved', v_status;
  end if;

  update public.business_alert_access
     set policy_accepted_at = now(),
         policy_accepted_by = auth.uid(),
         status             = 'active',
         activated_at       = coalesce(activated_at, now())
   where business_id = p_business_id;
end;
$$;

revoke all on function public.accept_alert_policy(uuid) from public;
grant execute on function public.accept_alert_policy(uuid) to authenticated;

comment on function public.accept_alert_policy(uuid) is
  'Owner accepts the alerts usage policy, moving approved -> active. Re-checks ownership, approval and Premium server-side.';
